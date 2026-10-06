import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import { ParticipantKind } from '../../domain/entities/Participant'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { CombatDecisionEvent } from '../../domain/decision/CombatDecisionEvent'
import { BattleMode } from '../../domain/value-objects/BattleMode'
import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { BattleEventPublisherPort } from '../ports/BattleEventPublisherPort'
import type { RoomCommandLockPort } from '../ports/RoomCommandLockPort'
import type { CommandIdFingerprintPort } from '../ports/CommandIdFingerprintPort'
import { BattleDecisionStateAssembler } from '../services/BattleDecisionStateAssembler'
import { LegalActionGenerator } from '../services/LegalActionGenerator'
import type { DecisionPolicySelector } from '../services/DecisionPolicySelector'
import type { CombatDecisionRecorder } from '../services/CombatDecisionRecorder'
import type {
  LiveMctsTeacherLabeler,
  PendingMctsTeacherLabel,
} from '../services/LiveMctsTeacherLabeler'
import type { BattleFinalizer } from '../services/BattleFinalizer'
import type { BattleDeadlineSettler } from '../services/BattleDeadlineSettler'
import type { ExecuteBasicAttack, ExecuteBasicAttackResult } from './ExecuteBasicAttack'
import type { UseSkill } from './UseSkill'
import type { UseEpic } from './UseEpic'
import type { CompleteBattleTurn } from './CompleteBattleTurn'

export interface ExecuteAiTurnLogger {
  error(message: string, context?: Readonly<Record<string, string>>): void
}

type ActionResult = ExecuteBasicAttackResult

interface ExecutedAiTurn {
  readonly roomId: string
  readonly commandId: string
  readonly result: ActionResult
  readonly decision: CombatDecisionEvent | null
  readonly pendingLabel: PendingMctsTeacherLabel | null
}

const actionTarget = (action: LegalAction): CombatantKey | undefined =>
  action.target.scope === 'COMBATANT' ? action.target.combatant : undefined

/** Texto crudo de la identidad del turno, antes de acotarlo con un fingerprint determinista. */
const aiTurnIdentity = (battleId: string, turnsCompleted: number, actor: CombatantKey): string =>
  `ai-turn:${battleId}:${String(turnsCompleted)}:${actor.teamLabel}:${String(actor.seat)}`

/**
 * Orquesta un unico turno AI JcE 1v1. La politica decide; los casos de uso de
 * ataque/habilidad/epica vuelven a planificar y ejecutan el motor autoritativo.
 */
export class ExecuteAiTurn {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly lock: RoomCommandLockPort,
    private readonly policies: DecisionPolicySelector,
    private readonly attack: ExecuteBasicAttack,
    private readonly skill: UseSkill,
    private readonly epic: UseEpic,
    private readonly completeTurn: CompleteBattleTurn,
    private readonly recorder: CombatDecisionRecorder,
    private readonly publisher: BattleEventPublisherPort,
    private readonly finalizer: BattleFinalizer,
    private readonly commandIds: CommandIdFingerprintPort,
    private readonly settler: BattleDeadlineSettler | null = null,
    private readonly states: BattleDecisionStateAssembler = new BattleDecisionStateAssembler(),
    private readonly actions: LegalActionGenerator = new LegalActionGenerator(),
    /** EN-036.2 (#566, correccion de alcance sobre PR#81): ver `ExecuteBasicAttack`. */
    private readonly liveTeacherLabeler: LiveMctsTeacherLabeler | null = null,
  ) {}

  async execute(roomId: string): Promise<boolean> {
    const executed = await this.lock.run(roomId, () => this.executeExclusively(roomId))

    if (executed === null) return false

    const { result } = executed

    if (!result.replayed) {
      try {
        this.publisher.publish(executed.roomId, [result.event, ...result.followUp])
      } catch {
        // Persistido antes de difundir; `resume` recupera cualquier evento perdido.
      }

      if (executed.decision !== null) {
        await this.recorder.record(executed.decision)
        void this.liveTeacherLabeler?.persist(executed.pendingLabel)
      }
      if (result.finished !== null) this.finalizer.afterFinished(result.finished)
    }

    return true
  }

  private async executeExclusively(roomId: string): Promise<ExecutedAiTurn | null> {
    let room = await this.rooms.findById(roomId)

    if (!this.isAutomatable(room)) return null
    if (this.settler !== null) room = await this.settler.settle(room)
    if (!this.isAutomatable(room)) return null

    const battle = room.battle
    if (battle === null) return null

    const stateBefore = this.states.assemble(room)
    const legalActions = this.actions.generateAvailable(room)
    const actor = stateBefore.actor.identity
    const commandId = this.commandIds.fingerprint(
      aiTurnIdentity(room.id, battle.turnsCompleted, actor),
    )

    if (legalActions.length === 0) {
      // SYSTEM END_TURN (§21, correccion de alcance sobre PR#81): nunca es
      // una decision de politica, nunca llama a MctsTeacher, nunca genera
      // teacher label.
      const decision = this.recorder.tryPrepareOnline({
        commandId,
        battleId: room.id,
        decisionSequence: battle.turnsCompleted,
        origin: 'ONLINE',
        mode: room.mode,
        actor,
        decisionSource: 'SYSTEM',
        stateBefore,
        legalActions,
        selectedAction: { kind: 'END_TURN' },
      })
      const completed = await this.completeTurn.executeExclusively({
        roomId: room.id,
        actorPlayerId: null,
        commandId,
      })

      return {
        roomId: room.id,
        commandId,
        decision,
        pendingLabel: null,
        result: {
          event: completed.event,
          replayed: completed.replayed,
          followUp: [],
          finished: null,
        },
      }
    }

    const selected = await this.policies.select(stateBefore, legalActions)
    const decision = this.recorder.tryPrepareOnline({
      commandId,
      battleId: room.id,
      decisionSequence: battle.turnsCompleted,
      origin: 'ONLINE',
      mode: room.mode,
      actor,
      decisionSource: selected.source,
      stateBefore,
      legalActions,
      selectedAction: selected.action,
    })
    // El teacher genera SU PROPIA seleccion/distribucion de forma
    // independiente (§20): nunca reutiliza `selected.action` (la eleccion
    // real de RuleBased/Neural/etc.) como si fuera la recomendacion MCTS.
    const pendingLabel = this.liveTeacherLabeler?.prepare(room, decision) ?? null
    const result = await this.executeAction(room.id, actor, commandId, selected.action)

    return { roomId: room.id, commandId, result, decision, pendingLabel }
  }

  private executeAction(
    roomId: string,
    actor: CombatantKey,
    commandId: string,
    action: LegalAction,
  ): Promise<ActionResult> {
    if (action.kind === 'BASIC_ATTACK') {
      const target = actionTarget(action)
      if (target === undefined) throw new Error('BASIC_ATTACK sin objetivo COMBATANT.')
      return this.attack.executeForActorExclusively({ roomId, actor, commandId, target })
    }

    if (action.kind === 'ABILITY') {
      return this.skill.executeForActorExclusively({
        roomId,
        actor,
        commandId,
        abilityId: action.abilityId,
        ...(action.target.scope === 'COMBATANT' ? { target: action.target.combatant } : {}),
      })
    }

    return this.epic.executeForActorExclusively({
      roomId,
      actor,
      commandId,
      ...(action.target.scope === 'COMBATANT' ? { target: action.target.combatant } : {}),
    })
  }

  private isAutomatable(room: BattleRoom | null): room is BattleRoom {
    if (room === null) return false

    if (
      room.mode !== BattleMode.Pve ||
      room.tournament !== null ||
      room.status !== BattleRoomStatus.InBattle ||
      room.battle === null
    ) {
      return false
    }

    if (
      room.battle.turnOrder.length !== 2 ||
      room.battle.currentEntry.kind !== ParticipantKind.Ai
    ) {
      return false
    }

    const kinds = room.battle.turnOrder.map((entry) => entry.kind)
    return (
      kinds.filter((kind) => kind === ParticipantKind.Human).length === 1 &&
      kinds.filter((kind) => kind === ParticipantKind.Ai).length === 1
    )
  }
}

/** Adaptador pequeno para que una accion humana ya persistida nunca se rechace si falla el bot. */
export class AiTurnTrigger {
  constructor(
    private readonly turns: Pick<ExecuteAiTurn, 'execute'>,
    private readonly logger: ExecuteAiTurnLogger,
  ) {}

  async afterTransition(roomId: string): Promise<void> {
    try {
      await this.turns.execute(roomId)
    } catch (error: unknown) {
      this.logger.error('ai_turn_execution_failed', {
        roomId,
        reason: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
}
