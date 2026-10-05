import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { LegalAction } from '../../domain/decision/LegalAction'
import { legalActionIdentity, resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type {
  MctsCandidateResult,
  MctsTeacherConfig,
  MctsTeacherResult,
} from '../../domain/decision/MctsTeacherResult'
import {
  evaluateBattleUtility,
  type BattleUtilityActorVitals,
  type BattleUtilityEnemyVitals,
  type BattleUtilityOutcome,
} from '../../domain/policies/BattleUtilityEvaluator'
import { deriveMctsRolloutSeed } from '../../domain/policies/MctsSeedDerivation'
import {
  DecisionStateUnavailableError,
  NoLegalDecisionActionsError,
} from '../../domain/errors/DecisionContractErrors'
import { InvalidMctsConfigError } from '../../domain/errors/MctsErrors'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import { RandomSeed } from '../../domain/value-objects/RandomSeed'
import type { AiDecisionPort } from '../ports/AiDecisionPort'
import type { MctsSimulationPort } from '../ports/MctsSimulationPort'
import type { RandomSequenceFactoryPort, RandomSequencePort } from '../ports/RandomSequencePort'
import { RuleBasedPolicy } from '../policies/RuleBasedPolicy'
import { BattleDecisionStateAssembler } from './BattleDecisionStateAssembler'
import { LegalActionGenerator } from './LegalActionGenerator'

/** `END_TURN` (legalActions = []) representado como una arista mas, interna a la busqueda. */
const END_TURN_EDGE = 'END_TURN'

interface MctsEdge {
  /** `null` solo representa `END_TURN`; nunca aparece entre las aristas del nodo RAIZ (ver `search`). */
  readonly action: LegalAction | null
  child: MctsNode | null
}

interface MctsNode {
  readonly room: BattleRoom
  readonly depthPlies: number
  readonly terminal: boolean
  /** `true` cuando se trunco por `maxDepthPlies`: hoja forzada, sin aristas (nunca se re-expande). */
  readonly depthCapped: boolean
  visits: number
  totalUtility: number
  /** Orden de expansion FIJO y determinista (decision v1: ver cabecera de `MctsSearch`). */
  readonly edgeOrder: readonly string[]
  readonly edges: ReadonlyMap<string, MctsEdge>
}

/**
 * Extrae, de forma pura y SIN pasar por `BattleDecisionStateAssembler` (atado
 * a "de quien es el turno"), los datos crudos que `BattleUtilityEvaluator`
 * necesita del actor raiz y de sus enemigos. La perspectiva es SIEMPRE la del
 * equipo del actor raiz, fijada una sola vez al iniciar la busqueda, sin
 * importar de quien sea el turno en la hoja evaluada (Management Task #565,
 * §29). Una sala `FINISHED` conserva `battle` (HU-21 restaura Poder pero no
 * vacia el snapshot de combate), asi que esta extraccion funciona igual de
 * hojas terminales que de hojas truncadas por profundidad.
 */
export const extractUtilityVitals = (
  room: BattleRoom,
  rootActor: CombatantKey,
): { actor: BattleUtilityActorVitals; enemies: readonly BattleUtilityEnemyVitals[] } => {
  const battle = room.battle
  if (battle === null) {
    throw new DecisionStateUnavailableError('la sala simulada no esta en batalla')
  }

  const actorCombatant = battle.combatantFor(rootActor)
  // `== null`: el unico encadenamiento opcional que cubre "sin combatiente" (undefined)
  // y "sin perfil" (null) a la vez, que es exactamente lo que se queria expresar.
  if (actorCombatant?.profile == null) {
    throw new DecisionStateUnavailableError('el actor raiz no tiene perfil de combate valido')
  }
  if (actorCombatant.currentHealth === null) {
    throw new DecisionStateUnavailableError('el actor raiz no tiene Vida valida')
  }

  const actor: BattleUtilityActorVitals = {
    currentHealth: actorCombatant.currentHealth,
    maxHealth: actorCombatant.profile.maxHealth,
    power:
      actorCombatant.profile.maxPower === undefined || actorCombatant.currentPower === null
        ? null
        : { current: actorCombatant.currentPower, max: actorCombatant.profile.maxPower },
  }

  const enemies: BattleUtilityEnemyVitals[] = battle.turnOrder
    .filter((entry) => entry.teamLabel !== rootActor.teamLabel)
    .map((entry) => {
      const combatant = battle.combatantFor(entry)
      if (combatant?.profile == null || combatant.currentHealth === null) {
        throw new DecisionStateUnavailableError('un enemigo no tiene Vida/perfil validos')
      }
      return { currentHealth: combatant.currentHealth, maxHealth: combatant.profile.maxHealth }
    })

  return { actor, enemies: Object.freeze(enemies) }
}

const uctScore = (child: MctsNode, parentVisits: number, explorationConstant: number): number => {
  const exploitation = child.totalUtility / child.visits
  const exploration = explorationConstant * Math.sqrt(Math.log(parentVisits) / child.visits)
  return exploitation + exploration
}

/** Compara identidades de arista de forma estable y determinista (desempates). */
const compareEdgeKey = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/**
 * Teacher MCTS (UCT) para EN-036.1 (Management Task #565). Busca, usando
 * UNICAMENTE el motor real de Combat sobre clones aislados
 * (`MctsSimulationPort`), la mejor accion del ACTOR RAIZ en el estado
 * recibido. NUNCA productiva: no la invoca `DecisionPolicySelector` ni
 * ninguna ruta HTTP/WS/cron, solo herramientas de teacher/dataset.
 *
 * DECISIONES TECNICAS V1 (no requisitos funcionales; ampliadas en
 * `docs/en-036-mcts-teacher.md`):
 *
 *  - El arbol SOLO ramifica en los turnos del actor raiz. Los turnos del
 *    equipo rival (dentro del arbol y durante el rollout) se resuelven
 *    siempre con la misma politica fija de rollout (`RuleBasedPolicy`), nunca
 *    se buscan: evita un UCT adversarial de dos bandos y mantiene cada ply
 *    resuelto por las reglas reales, sin montar un segundo motor.
 *  - La expansion de aristas no visitadas sigue SIEMPRE el orden en que
 *    `LegalActionGenerator` las genera (determinista, ordenado por
 *    `legalActionIdentity`): el UNICO azar de toda la busqueda es el que
 *    consume el motor real a traves de la secuencia aislada de cada rollout;
 *    MCTS no inventa un sorteo propio para elegir que ramificar.
 *  - La utilidad se evalua SIEMPRE desde la perspectiva del equipo del actor
 *    raiz, fijada al iniciar la busqueda, en toda hoja (terminal o truncada
 *    por profundidad) sin importar de quien sea el turno en ese nodo.
 */
export class MctsSearch {
  constructor(
    private readonly simulation: MctsSimulationPort,
    private readonly randomSequenceFactory: RandomSequenceFactoryPort,
    private readonly rolloutPolicy: AiDecisionPort = new RuleBasedPolicy(),
    private readonly legalActions: LegalActionGenerator = new LegalActionGenerator(),
    private readonly stateAssembler: BattleDecisionStateAssembler = new BattleDecisionStateAssembler(),
  ) {}

  async search(
    room: BattleRoom,
    config: MctsTeacherConfig,
    simulationSeed: number,
  ): Promise<MctsTeacherResult> {
    this.validateConfig(config)
    RandomSeed.create(simulationSeed)

    if (room.status !== BattleRoomStatus.InBattle || room.battle === null) {
      throw new DecisionStateUnavailableError(
        'la sala no esta en curso para iniciar una busqueda MCTS',
      )
    }

    const rootActor: CombatantKey = {
      teamLabel: room.battle.currentEntry.teamLabel,
      seat: room.battle.currentEntry.seat,
    }
    const rootLegalActions = this.legalActions.generateAvailable(room)
    if (rootLegalActions.length === 0) {
      throw new NoLegalDecisionActionsError()
    }

    const root = this.makeNode(room, 0, rootLegalActions)

    for (let i = 0; i < config.rollouts; i += 1) {
      const seed = deriveMctsRolloutSeed(simulationSeed, i)
      const sequence = this.randomSequenceFactory.create(seed)
      const plyId = { value: 0 }
      const commandNamespace = `mcts:${String(i)}`

      const path = this.select(root, config)
      const leaf = path[path.length - 1]
      if (leaf === undefined) throw new InvalidMctsConfigError('ruta de seleccion vacia')

      if (leaf.terminal || leaf.depthCapped) {
        const utility = this.evaluate(leaf.room, rootActor, leaf.terminal)
        this.backpropagate(path, utility)
        continue
      }

      const untriedKey = leaf.edgeOrder.find((key) => leaf.edges.get(key)?.child === null)
      const edge = untriedKey === undefined ? undefined : leaf.edges.get(untriedKey)
      if (edge === undefined) {
        throw new InvalidMctsConfigError('nodo sin aristas no visitadas ni hoja')
      }

      const expanded = await this.expand(
        leaf,
        edge,
        rootActor,
        config,
        sequence,
        commandNamespace,
        plyId,
      )
      edge.child = expanded

      const rolledOut = await this.rollout(expanded, config, sequence, commandNamespace, plyId)
      const utility = this.evaluate(rolledOut.room, rootActor, rolledOut.terminal)
      this.backpropagate([...path, expanded], utility)
    }

    return this.buildResult(root, config, simulationSeed)
  }

  private validateConfig(config: MctsTeacherConfig): void {
    if (!Number.isInteger(config.rollouts) || config.rollouts < 1) {
      throw new InvalidMctsConfigError(`rollouts invalido (${String(config.rollouts)}).`)
    }
    if (!Number.isInteger(config.maxDepthPlies) || config.maxDepthPlies < 1) {
      throw new InvalidMctsConfigError(`maxDepthPlies invalido (${String(config.maxDepthPlies)}).`)
    }
    if (!Number.isFinite(config.explorationConstant) || config.explorationConstant < 0) {
      throw new InvalidMctsConfigError(
        `explorationConstant invalido (${String(config.explorationConstant)}).`,
      )
    }
  }

  private makeNode(
    room: BattleRoom,
    depthPlies: number,
    ownLegalActions: readonly LegalAction[],
  ): MctsNode {
    const terminal = room.status === BattleRoomStatus.Finished
    const edgeKeys = terminal
      ? []
      : ownLegalActions.length === 0
        ? [END_TURN_EDGE]
        : [...ownLegalActions.map((action) => legalActionIdentity(action))].sort(compareEdgeKey)
    const edges = new Map<string, MctsEdge>(
      edgeKeys.map((key) => [
        key,
        {
          action:
            key === END_TURN_EDGE
              ? null
              : (ownLegalActions.find((action) => legalActionIdentity(action) === key) ?? null),
          child: null,
        },
      ]),
    )

    return {
      room,
      depthPlies,
      terminal,
      depthCapped: false,
      visits: 0,
      totalUtility: 0,
      edgeOrder: edgeKeys,
      edges,
    }
  }

  private depthCappedLeaf(room: BattleRoom, depthPlies: number): MctsNode {
    return {
      room,
      depthPlies,
      terminal: false,
      depthCapped: true,
      visits: 0,
      totalUtility: 0,
      edgeOrder: [],
      edges: new Map(),
    }
  }

  private select(root: MctsNode, config: MctsTeacherConfig): MctsNode[] {
    const path: MctsNode[] = [root]
    let current = root

    for (;;) {
      if (current.terminal || current.depthCapped) return path

      const hasUntried = current.edgeOrder.some((key) => current.edges.get(key)?.child === null)
      if (hasUntried) return path

      let best: MctsNode | null = null
      let bestScore = -Infinity
      let bestKey = ''
      for (const key of current.edgeOrder) {
        const child = current.edges.get(key)?.child
        if (child === null || child === undefined) continue
        const score = uctScore(child, current.visits, config.explorationConstant)
        if (score > bestScore || (score === bestScore && compareEdgeKey(key, bestKey) < 0)) {
          best = child
          bestScore = score
          bestKey = key
        }
      }

      if (best === null) return path
      path.push(best)
      current = best
    }
  }

  private async expand(
    parent: MctsNode,
    edge: MctsEdge,
    rootActor: CombatantKey,
    config: MctsTeacherConfig,
    sequence: RandomSequencePort,
    commandNamespace: string,
    plyId: { value: number },
  ): Promise<MctsNode> {
    const parentEntry = parent.room.battle?.currentEntry
    if (parentEntry === undefined) {
      throw new InvalidMctsConfigError('expansion sobre un nodo sin batalla activa')
    }
    const mover: CombatantKey = { teamLabel: parentEntry.teamLabel, seat: parentEntry.seat }
    const commandId = `${commandNamespace}:${String(plyId.value)}`
    plyId.value += 1

    const step =
      edge.action === null
        ? await this.simulation.applyEndTurn(parent.room, commandId)
        : await this.simulation.applyAction(parent.room, mover, edge.action, commandId, sequence)

    return this.materializeUntilRootTurn(
      step.room,
      parent.depthPlies + 1,
      step.finished,
      rootActor,
      config,
      sequence,
      commandNamespace,
      plyId,
    )
  }

  private async materializeUntilRootTurn(
    room: BattleRoom,
    depthPlies: number,
    alreadyFinished: boolean,
    rootActor: CombatantKey,
    config: MctsTeacherConfig,
    sequence: RandomSequencePort,
    commandNamespace: string,
    plyId: { value: number },
  ): Promise<MctsNode> {
    let current = room
    let depth = depthPlies
    let finished = alreadyFinished

    while (!finished && depth < config.maxDepthPlies) {
      const currentEntry = current.battle?.currentEntry
      if (currentEntry === undefined || currentEntry.teamLabel === rootActor.teamLabel) break
      const commandId = `${commandNamespace}:${String(plyId.value)}`
      plyId.value += 1
      const step = await this.advanceOnePly(current, commandId, sequence)
      current = step.room
      finished = step.finished
      depth += 1
    }

    if (finished) return this.makeNode(current, depth, [])
    if (depth >= config.maxDepthPlies) return this.depthCappedLeaf(current, depth)

    const legalActionsHere = this.legalActions.generateAvailable(current)
    return this.makeNode(current, depth, legalActionsHere)
  }

  /** Resuelve UN ply (de quien sea el turno vigente) con la politica de rollout fija. */
  private async advanceOnePly(
    room: BattleRoom,
    commandId: string,
    sequence: RandomSequencePort,
  ): Promise<{ room: BattleRoom; finished: boolean }> {
    const currentEntry = room.battle?.currentEntry
    if (currentEntry === undefined) {
      throw new InvalidMctsConfigError('avance de ply sin batalla activa')
    }

    const legalActionsHere = this.legalActions.generateAvailable(room)
    if (legalActionsHere.length === 0) {
      return this.simulation.applyEndTurn(room, commandId)
    }

    const state = this.stateAssembler.assemble(room)
    const intent = await this.rolloutPolicy.decide(state, legalActionsHere)
    const action = resolveLegalAction(intent, legalActionsHere)
    const mover: CombatantKey = { teamLabel: currentEntry.teamLabel, seat: currentEntry.seat }
    return this.simulation.applyAction(room, mover, action, commandId, sequence)
  }

  /** Continua jugando (TODOS los movimientos via la politica de rollout) hasta terminal o tope. */
  private async rollout(
    node: MctsNode,
    config: MctsTeacherConfig,
    sequence: RandomSequencePort,
    commandNamespace: string,
    plyId: { value: number },
  ): Promise<{ room: BattleRoom; terminal: boolean }> {
    let current = node.room
    let depth = node.depthPlies
    let terminal = node.terminal

    while (!terminal && depth < config.maxDepthPlies) {
      const commandId = `${commandNamespace}:${String(plyId.value)}`
      plyId.value += 1
      const step = await this.advanceOnePly(current, commandId, sequence)
      current = step.room
      terminal = step.finished
      depth += 1
    }

    return { room: current, terminal }
  }

  /**
   * W (§14): victoria/derrota/empate del equipo raiz si `terminal`, o el valor
   * neutral si la hoja se trunco por profundidad sin terminar la batalla. Un
   * empate (`winnerTeamLabel: null` en una sala YA `FINISHED`) reusa el mismo
   * valor neutral que "aun no terminal": ninguno de los dos favorece o
   * penaliza al actor raiz (decision v1, ver `docs/en-036-mcts-teacher.md`).
   */
  private evaluate(room: BattleRoom, rootActor: CombatantKey, terminal: boolean): number {
    let outcome: BattleUtilityOutcome
    if (!terminal) {
      outcome = 'NON_TERMINAL'
    } else {
      const winner = room.result?.winnerTeamLabel ?? null
      outcome = winner === null ? 'NON_TERMINAL' : winner === rootActor.teamLabel ? 'WIN' : 'LOSS'
    }

    const { actor, enemies } = extractUtilityVitals(room, rootActor)
    return evaluateBattleUtility(outcome, actor, enemies).utility
  }

  private backpropagate(path: readonly MctsNode[], utility: number): void {
    for (const node of path) {
      node.visits += 1
      node.totalUtility += utility
    }
  }

  private buildResult(
    root: MctsNode,
    config: MctsTeacherConfig,
    simulationSeed: number,
  ): MctsTeacherResult {
    const candidates: MctsCandidateResult[] = root.edgeOrder
      .map((key) => {
        const edge = root.edges.get(key)
        if (edge?.action == null) {
          throw new InvalidMctsConfigError('el nodo raiz no puede tener una arista END_TURN')
        }
        const action = edge.action
        const visits = edge.child?.visits ?? 0
        const meanUtility = visits === 0 ? 0 : (edge.child?.totalUtility ?? 0) / visits
        return { action, actionIdentity: key, visits, meanUtility, probability: 0 }
      })
      .sort(
        (left, right) =>
          right.visits - left.visits || compareEdgeKey(left.actionIdentity, right.actionIdentity),
      )

    const totalVisits = candidates.reduce((sum, candidate) => sum + candidate.visits, 0)
    const withProbability: MctsCandidateResult[] = candidates.map((candidate) =>
      Object.freeze({
        ...candidate,
        probability: totalVisits === 0 ? 0 : candidate.visits / totalVisits,
      }),
    )

    const [best] = withProbability
    if (best === undefined)
      throw new InvalidMctsConfigError('la busqueda no genero ningun candidato')

    return Object.freeze({
      config,
      simulationSeed,
      stateSchemaVersion: 1 as const,
      selectedAction: best.action,
      candidates: Object.freeze(withProbability),
    })
  }
}
