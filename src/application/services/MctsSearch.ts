import type { BattleEvent } from '../../domain/entities/BattleEvent'
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
import { filterStrategicCandidates } from './MctsStrategicCandidateFilter'

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

interface RootCandidateStats {
  readonly action: LegalAction
  visits: number
  totalUtility: number
}

const uctScore = (
  candidate: RootCandidateStats,
  totalVisits: number,
  explorationConstant: number,
): number => {
  const exploitation = candidate.totalUtility / candidate.visits
  const exploration = explorationConstant * Math.sqrt(Math.log(totalVisits) / candidate.visits)
  return exploitation + exploration
}

/** Compara identidades de arista de forma estable y determinista (desempates). */
const compareEdgeKey = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const sameCombatant = (left: CombatantKey, right: CombatantKey): boolean =>
  left.teamLabel === right.teamLabel && left.seat === right.seat

/**
 * Lee `payload.power.after` de un evento SI lo tiene (`skillUsed`,
 * `healSkillUsed`, `directDamageSkillUsed`, `epicUsed`); `null` en cualquier
 * otro caso (p. ej. `basicAttackResolved`, que nunca toca Poder).
 */
const powerAfterFromEvent = (event: BattleEvent): number | null => {
  const payload: unknown = event.payload
  if (typeof payload !== 'object' || payload === null || !('power' in payload)) return null
  const power = payload.power
  if (typeof power !== 'object' || power === null || !('after' in power)) return null
  const after = power.after
  return typeof after === 'number' ? after : null
}

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
 *  - **Arbol de un solo nivel.** UCT asigna los `rollouts` disponibles entre
 *    las acciones legales (estrategicas) del actor raiz; TODO lo que ocurre
 *    despues de esa primera accion -- el resto del propio turno, los turnos
 *    del rival, cualquier turno posterior del actor raiz dentro del mismo
 *    rollout -- se juega con `RuleBasedPolicy`, nunca se vuelve a buscar.
 *    Revision anterior de este archivo mantenia un arbol mas profundo cuyas
 *    aristas, una vez expandidas, CONGELABAN el resultado aleatorio de la
 *    primera vez que se jugaron (el mismo acierto/critico/dano para siempre);
 *    en un motor estocastico eso sesga el teacher hacia lo que haya salido en
 *    el primer muestreo. Con un solo nivel, CADA rollout vuelve a aplicar la
 *    accion elegida con la secuencia de ESE rollout: nunca se reutiliza una
 *    transicion ya muestreada.
 *  - La expansion (primera visita) de cada candidata sigue el orden de
 *    `legalActionIdentity` (determinista): el UNICO azar de toda la busqueda
 *    es el que consume el motor real a traves de la secuencia aislada de cada
 *    rollout.
 *  - Antes de repartir rollouts, `filterStrategicCandidates` descarta las
 *    curaciones desperdiciadas (regla de salud de EN-036 #555: un receptor
 *    con `healthRatio >= 0.90`) para no gastar presupuesto en ellas; nunca
 *    toca la legalidad real de Combat.
 *  - La utilidad se evalua SIEMPRE desde la perspectiva del equipo del actor
 *    raiz. El Poder NUNCA se lee directamente de la hoja final: una sala
 *    `FINISHED` ya paso por `BattleRoom.finish() -> restoreAllPower()` (HU-11)
 *    y mostraria Poder maximo igual para una victoria agotandolo todo que
 *    para una sin gastar nada. En vez de eso, cada rollout seguimiento SU
 *    PROPIO Poder del actor raiz ply a ply, leyendo `payload.power.after` de
 *    cada evento de habilidad/epica que el actor raiz protagoniza (el unico
 *    dato que expone el valor justo antes de cualquier restauracion), y usa
 *    ese valor seguido -- nunca el de la sala final -- para `P`.
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
    const legalActionsAll = this.legalActions.generateAvailable(room)
    if (legalActionsAll.length === 0) {
      throw new NoLegalDecisionActionsError()
    }

    const strategicCandidates = filterStrategicCandidates(room, rootActor, legalActionsAll)
    const stats = new Map<string, RootCandidateStats>(
      strategicCandidates.map((action) => [
        legalActionIdentity(action),
        { action, visits: 0, totalUtility: 0 },
      ]),
    )
    const order = [...stats.keys()].sort(compareEdgeKey)
    const initialPower = extractUtilityVitals(room, rootActor).actor.power

    for (let i = 0; i < config.rollouts; i += 1) {
      const seed = deriveMctsRolloutSeed(simulationSeed, i)
      const sequence = this.randomSequenceFactory.create(seed)
      const chosenKey = this.selectRootAction(stats, order, config)
      const chosen = stats.get(chosenKey)
      if (chosen === undefined) throw new InvalidMctsConfigError('candidata seleccionada ausente')

      const {
        room: finalRoom,
        terminal,
        rootActorPower,
      } = await this.simulateTrajectory(
        room,
        rootActor,
        chosen.action,
        initialPower,
        config,
        sequence,
        `mcts:${String(i)}`,
      )
      const utility = this.evaluate(finalRoom, rootActor, terminal, rootActorPower)

      chosen.visits += 1
      chosen.totalUtility += utility
    }

    return this.buildResult(stats, order, config, simulationSeed)
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

  /** Primera visita (orden fijo) si queda alguna; si no, argmax UCT con desempate determinista. */
  private selectRootAction(
    stats: ReadonlyMap<string, RootCandidateStats>,
    order: readonly string[],
    config: MctsTeacherConfig,
  ): string {
    const untried = order.find((key) => stats.get(key)?.visits === 0)
    if (untried !== undefined) return untried

    const totalVisits = order.reduce((sum, key) => sum + (stats.get(key)?.visits ?? 0), 0)

    let bestKey = ''
    let bestScore = -Infinity
    for (const key of order) {
      const candidate = stats.get(key)
      if (candidate === undefined) continue
      const score = uctScore(candidate, totalVisits, config.explorationConstant)
      if (score > bestScore || (score === bestScore && compareEdgeKey(key, bestKey) < 0)) {
        bestKey = key
        bestScore = score
      }
    }

    return bestKey
  }

  /**
   * Aplica `firstAction` FRESCA (con la secuencia de ESTE rollout) y continua
   * el resto de la trayectoria -- ambos lados, cuantos plies hagan falta --
   * via la politica de rollout fija, hasta terminal o `maxDepthPlies`.
   *
   * Tambien sigue el Poder del actor raiz PLY A PLY, EMPEZANDO en
   * `initialPower` (el de la sala raiz, el mismo para todos los rollouts):
   * cada vez que el actor raiz protagoniza un evento con `power.after`
   * (habilidad o epica), el seguimiento se actualiza a ese valor; cualquier
   * otro ply (ataque basico, turno del rival, `END_TURN`) lo deja intacto.
   * Es el UNICO dato fiable del Poder del actor raiz si la hoja final resulta
   * terminal (ver cabecera de la clase).
   */
  private async simulateTrajectory(
    room: BattleRoom,
    rootActor: CombatantKey,
    firstAction: LegalAction,
    initialPower: BattleUtilityActorVitals['power'],
    config: MctsTeacherConfig,
    sequence: RandomSequencePort,
    commandNamespace: string,
  ): Promise<{
    room: BattleRoom
    terminal: boolean
    rootActorPower: BattleUtilityActorVitals['power']
  }> {
    const plyId = { value: 0 }
    const firstCommandId = `${commandNamespace}:0`
    plyId.value = 1

    const first = await this.simulation.applyAction(
      room,
      rootActor,
      firstAction,
      firstCommandId,
      sequence,
    )

    let current = first.room
    let terminal = first.finished
    let depth = 1
    let rootActorPower = this.trackRootPower(initialPower, rootActor, rootActor, first.event)

    while (!terminal && depth < config.maxDepthPlies) {
      const commandId = `${commandNamespace}:${String(plyId.value)}`
      plyId.value += 1
      const step = await this.advanceOnePly(current, commandId, sequence)
      rootActorPower = this.trackRootPower(rootActorPower, rootActor, step.actor, step.event)
      current = step.room
      terminal = step.finished
      depth += 1
    }

    return { room: current, terminal, rootActorPower }
  }

  private trackRootPower(
    current: BattleUtilityActorVitals['power'],
    rootActor: CombatantKey,
    mover: CombatantKey,
    event: BattleEvent,
  ): BattleUtilityActorVitals['power'] {
    if (current === null || !sameCombatant(mover, rootActor)) return current
    const after = powerAfterFromEvent(event)
    return after === null ? current : { current: after, max: current.max }
  }

  /** Resuelve UN ply (de quien sea el turno vigente) con la politica de rollout fija. */
  private async advanceOnePly(
    room: BattleRoom,
    commandId: string,
    sequence: RandomSequencePort,
  ): Promise<{ room: BattleRoom; finished: boolean; actor: CombatantKey; event: BattleEvent }> {
    const currentEntry = room.battle?.currentEntry
    if (currentEntry === undefined) {
      throw new InvalidMctsConfigError('avance de ply sin batalla activa')
    }
    const mover: CombatantKey = { teamLabel: currentEntry.teamLabel, seat: currentEntry.seat }

    const legalActionsHere = this.legalActions.generateAvailable(room)
    if (legalActionsHere.length === 0) {
      const step = await this.simulation.applyEndTurn(room, commandId)
      return { ...step, actor: mover }
    }

    const state = this.stateAssembler.assemble(room)
    const intent = await this.rolloutPolicy.decide(state, legalActionsHere)
    const action = resolveLegalAction(intent, legalActionsHere)
    const step = await this.simulation.applyAction(room, mover, action, commandId, sequence)
    return { ...step, actor: mover }
  }

  /**
   * W (§14): victoria/derrota/empate del equipo raiz si `terminal`, o el valor
   * neutral si la hoja se trunco por profundidad sin terminar la batalla. Un
   * empate (`winnerTeamLabel: null` en una sala YA `FINISHED`) reusa el mismo
   * valor neutral que "aun no terminal": ninguno de los dos favorece o
   * penaliza al actor raiz (decision v1, ver `docs/en-036-mcts-teacher.md`).
   *
   * P (§12 + fix del bug #3 de la revision de #80): se usa SIEMPRE
   * `rootActorPower` (el seguimiento ply a ply de `simulateTrajectory`), NUNCA
   * el Poder leido directamente de `room`: en una hoja terminal `room` ya paso
   * por `restoreAllPower()` y mostraria Poder maximo sin importar cuanto se
   * gasto de verdad.
   */
  private evaluate(
    room: BattleRoom,
    rootActor: CombatantKey,
    terminal: boolean,
    rootActorPower: BattleUtilityActorVitals['power'],
  ): number {
    let outcome: BattleUtilityOutcome
    if (!terminal) {
      outcome = 'NON_TERMINAL'
    } else {
      const winner = room.result?.winnerTeamLabel ?? null
      outcome = winner === null ? 'NON_TERMINAL' : winner === rootActor.teamLabel ? 'WIN' : 'LOSS'
    }

    const { actor, enemies } = extractUtilityVitals(room, rootActor)
    const actorForEvaluation = { ...actor, power: rootActorPower }
    return evaluateBattleUtility(outcome, actorForEvaluation, enemies).utility
  }

  private buildResult(
    stats: ReadonlyMap<string, RootCandidateStats>,
    order: readonly string[],
    config: MctsTeacherConfig,
    simulationSeed: number,
  ): MctsTeacherResult {
    const candidates: MctsCandidateResult[] = order
      .map((key) => {
        const candidate = stats.get(key)
        if (candidate === undefined) {
          throw new InvalidMctsConfigError('candidata ausente al construir el resultado')
        }
        const meanUtility = candidate.visits === 0 ? 0 : candidate.totalUtility / candidate.visits
        return {
          action: candidate.action,
          actionIdentity: key,
          visits: candidate.visits,
          meanUtility,
          probability: 0,
        }
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
    if (best === undefined) {
      throw new InvalidMctsConfigError('la busqueda no genero ningun candidato')
    }

    return Object.freeze({
      config,
      simulationSeed,
      stateSchemaVersion: 1 as const,
      selectedAction: best.action,
      candidates: Object.freeze(withProbability),
    })
  }
}
