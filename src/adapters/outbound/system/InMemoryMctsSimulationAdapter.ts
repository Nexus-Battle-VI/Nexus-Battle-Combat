import type { BattleRoom } from '../../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../../domain/entities/Combatant'
import type { LegalAction } from '../../../domain/decision/LegalAction'
import { SimulationTransitionError } from '../../../domain/errors/MctsErrors'
import type { ClockPort } from '../../../application/ports/ClockPort'
import type { RandomSequencePort } from '../../../application/ports/RandomSequencePort'
import type { RoomCommandLockPort } from '../../../application/ports/RoomCommandLockPort'
import type {
  MctsSimulationPort,
  MctsSimulationStepResult,
} from '../../../application/ports/MctsSimulationPort'
import { ExecuteBasicAttack } from '../../../application/use-cases/ExecuteBasicAttack'
import { UseSkill } from '../../../application/use-cases/UseSkill'
import { UseEpic } from '../../../application/use-cases/UseEpic'
import { CompleteBattleTurn } from '../../../application/use-cases/CompleteBattleTurn'
import { InMemoryBattleRoomRepository } from '../persistence/InMemoryBattleRoomRepository'

/** Nunca se invoca: `*ForActorExclusively`/`executeExclusively` no toman el cerrojo de sala. */
const PASSTHROUGH_LOCK: RoomCommandLockPort = {
  run: <T>(_roomId: string, task: () => Promise<T>): Promise<T> => task(),
}

/** El clon es descartable y no se difunde a nadie: publicar es un no-op. */
const SILENT_PUBLISHER = { publish: (): void => undefined }

/**
 * Implementacion del `MctsSimulationPort` (EN-036.1, Management Task #565,
 * §17-§21): CADA llamada crea, para ese unico paso, un `InMemoryBattleRoomRepository`
 * nuevo (nunca el singleton de persistencia real ni el de ningun otro paso)
 * sembrado SOLO con el clon recibido, y construye instancias nuevas de los
 * casos de uso reales de Combat (nunca las instancias DI de produccion) para
 * que ninguna simulacion pueda, ni por error, tocar una sala real ni compartir
 * estado mutable con otra rama del arbol.
 *
 * Los `commandId` de simulacion deben ser unicos POR CLON (el llamador los
 * genera con un namespace que no colisiona con `room.handledCommands`
 * reales): un commandId repetido en este adaptador es siempre un defecto del
 * arnes de busqueda, nunca un reintento legitimo, de ahi que se trate como
 * `SimulationTransitionError` en vez de como una repeticion silenciosa.
 */
export class InMemoryMctsSimulationAdapter implements MctsSimulationPort {
  constructor(private readonly clock: ClockPort) {}

  async applyAction(
    room: BattleRoom,
    actor: CombatantKey,
    action: LegalAction,
    commandId: string,
    sequence: RandomSequencePort,
  ): Promise<MctsSimulationStepResult> {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(room, 0)

    const attack = new ExecuteBasicAttack(rooms, this.clock, sequence, PASSTHROUGH_LOCK)
    const skill = new UseSkill(rooms, this.clock, sequence, PASSTHROUGH_LOCK, attack)
    const epic = new UseEpic(rooms, this.clock, sequence, PASSTHROUGH_LOCK)

    const result = await this.dispatch(attack, skill, epic, room.id, actor, commandId, action)

    if (result.replayed) {
      throw new SimulationTransitionError(
        `commandId de simulacion repetido inesperadamente (${commandId}).`,
      )
    }

    if (result.finished !== null) return { room: result.finished, finished: true }

    const next = await rooms.findById(room.id)
    if (next === null) {
      throw new SimulationTransitionError('la sala clonada desaparecio tras aplicar la accion.')
    }

    return { room: next, finished: false }
  }

  async applyEndTurn(room: BattleRoom, commandId: string): Promise<MctsSimulationStepResult> {
    if (room.battle === null) {
      throw new SimulationTransitionError('la sala clonada no esta en batalla.')
    }

    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(room, 0)

    const completeTurn = new CompleteBattleTurn(rooms, this.clock, SILENT_PUBLISHER)
    const result = await completeTurn.executeExclusively({
      roomId: room.id,
      actorPlayerId: room.battle.currentEntry.playerId,
      commandId,
    })

    if (result.replayed) {
      throw new SimulationTransitionError(
        `commandId de simulacion (END_TURN) repetido inesperadamente (${commandId}).`,
      )
    }

    return { room: result.room, finished: false }
  }

  private dispatch(
    attack: ExecuteBasicAttack,
    skill: UseSkill,
    epic: UseEpic,
    roomId: string,
    actor: CombatantKey,
    commandId: string,
    action: LegalAction,
  ) {
    if (action.kind === 'BASIC_ATTACK') {
      if (action.target.scope !== 'COMBATANT') {
        throw new SimulationTransitionError('BASIC_ATTACK sin objetivo COMBATANT.')
      }
      return attack.executeForActorExclusively({
        roomId,
        actor,
        commandId,
        target: action.target.combatant,
      })
    }

    if (action.kind === 'ABILITY') {
      return skill.executeForActorExclusively({
        roomId,
        actor,
        commandId,
        abilityId: action.abilityId,
        ...(action.target.scope === 'COMBATANT' ? { target: action.target.combatant } : {}),
      })
    }

    return epic.executeForActorExclusively({
      roomId,
      actor,
      commandId,
      ...(action.target.scope === 'COMBATANT' ? { target: action.target.combatant } : {}),
    })
  }
}
