import { toBattleEventWire } from '../../../application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../../application/errors/ApplicationError'
import type { UseEpic } from '../../../application/use-cases/UseEpic'
import type { BattleFinalizer } from '../../../application/services/BattleFinalizer'
import type { AiTurnTrigger } from '../../../application/use-cases/ExecuteAiTurn'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  EpicOnCooldownError,
  EpicTargetRequiredError,
  InvalidCommandIdError,
  InvalidHealTargetError,
  InvalidTargetError,
  NoEpicEquippedError,
  NotYourTurnError,
  SameTeamTargetError,
  SkillsNotAvailableError,
  TargetUnavailableError,
  UnsupportedCombatProfileError,
  UnsupportedEpicEffectError,
} from '../../../domain/errors/BattleErrors'
import type { BattleEvent } from '../../../domain/entities/BattleEvent'
import type { CombatantKey } from '../../../domain/entities/Combatant'
import type { Logger } from '../../../infrastructure/observability/logger'
import type { PublishBattleEvents } from './BasicAttackRealtimeHandler'
import type { RealtimeSocket } from './RealtimeSocket'

/** Nombre del comando en el protocolo (correccion HU-19/HU-31, tras GAP-HU31-CATALOG-MULTI-EFFECT). */
export const USE_EPIC_COMMAND = 'useEpic'

const OPEN_STATE = 1
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Codigos estables de `command.rejected` propios del handler. */
export const EpicRejectionCode = Object.freeze({
  MalformedCommand: 'MALFORMED_COMMAND',
  InvalidCommandId: 'INVALID_COMMAND_ID',
  RoomNotFound: 'ROOM_NOT_FOUND',
  NotAParticipant: 'NOT_A_PARTICIPANT',
  BattleNotActive: 'BATTLE_NOT_ACTIVE',
  NotYourTurn: 'NOT_YOUR_TURN',
  CommandConflict: 'COMMAND_CONFLICT',
  InternalError: 'INTERNAL_ERROR',
} as const)

interface ParsedEpicCommand {
  readonly commandId: string
  readonly roomId: string
  /** AUSENTE si ningun efecto de la epica necesita un objetivo (SELF/ALLIED_GROUP). */
  readonly target?: CombatantKey
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value)

  return own.length === keys.length && keys.every((key) => own.includes(key))
}

const parseTarget = (value: unknown): CombatantKey | null => {
  if (!isPlainRecord(value) || !hasExactlyKeys(value, ['teamLabel', 'seat'])) {
    return null
  }

  const { teamLabel, seat } = value

  if (
    typeof teamLabel !== 'string' ||
    teamLabel.length === 0 ||
    typeof seat !== 'number' ||
    !Number.isInteger(seat) ||
    seat < 0
  ) {
    return null
  }

  return { teamLabel, seat }
}

/**
 * Valida la FORMA del comando: exactamente `type`, `commandId`, `roomId` y, SOLO si el
 * cliente lo trae, `target`. A diferencia de `useSkill`, no hay `abilityId`: la UNICA epica
 * ejecutable es la que esta congelada en el perfil del actor, nunca una que el cliente elija.
 * Cualquier otra clave (`effects`, `power`, `cooldown`...) hace el comando mal formado.
 */
export const parseEpicCommand = (message: Record<string, unknown>): ParsedEpicCommand | null => {
  const hasTarget = 'target' in message
  const expectedKeys = hasTarget
    ? ['type', 'commandId', 'roomId', 'target']
    : ['type', 'commandId', 'roomId']

  if (!hasExactlyKeys(message, expectedKeys)) {
    return null
  }

  const { commandId, roomId } = message

  if (typeof commandId !== 'string' || typeof roomId !== 'string' || !UUID_V4.test(roomId)) {
    return null
  }

  if (!hasTarget) {
    return { commandId, roomId }
  }

  const target = parseTarget(message.target)

  if (target === null) {
    return null
  }

  return { commandId, roomId, target }
}

/**
 * Traduce el comando `useEpic` (correccion HU-19/HU-31) del WebSocket a `UseEpic` y sus
 * errores a `command.rejected` con un codigo estable. No decide ninguna regla de combate.
 *
 * El actor es SIEMPRE el `sub` autenticado de la conexion. Un comando rechazado responde SOLO
 * a quien lo envio; un `commandId` repetido recibe de nuevo el evento ya persistido, solo el
 * remitente. El Poder de una epica es siempre 0: no existe un camino de degradacion (HU-11 no
 * aplica, usar la epica no es atacar).
 */
export class EpicRealtimeHandler {
  constructor(
    private readonly epic: UseEpic,
    private readonly logger: Logger,
    private readonly finalizer: BattleFinalizer | null = null,
    /** HU-93.2: dispara el turno AI tras una transicion humana valida (fail-open). */
    private readonly aiTurnTrigger: AiTurnTrigger | null = null,
  ) {}

  async handle(
    client: RealtimeSocket,
    subject: string,
    message: Record<string, unknown>,
    publish: PublishBattleEvents,
  ): Promise<void> {
    const command = parseEpicCommand(message)

    if (command === null) {
      const commandId = typeof message.commandId === 'string' ? message.commandId : undefined

      this.reject(client, EpicRejectionCode.MalformedCommand, commandId)
      return
    }

    try {
      const result = await this.epic.execute({
        roomId: command.roomId,
        requesterId: subject,
        commandId: command.commandId,
        ...(command.target === undefined ? {} : { target: command.target }),
      })

      this.logger.info('realtime_epica_resuelta', {
        roomId: command.roomId,
        commandId: command.commandId,
        eventType: result.event.type,
        seq: result.event.seq,
        replayed: result.replayed,
      })

      if (result.replayed) {
        this.send(client, command.roomId, result.event)
        return
      }

      try {
        publish(command.roomId, [result.event, ...result.followUp])
      } catch {
        this.logger.error('realtime_epica_difusion_fallo', {
          roomId: command.roomId,
          commandId: command.commandId,
        })
      }

      if (result.finished !== null) {
        this.finalizer?.afterFinished(result.finished)
      } else {
        void this.aiTurnTrigger?.afterTransition(command.roomId)
      }
    } catch (error: unknown) {
      this.reject(client, this.codeFor(error, command), command.commandId)
    }
  }

  private send(client: RealtimeSocket, roomId: string, event: BattleEvent): void {
    if (client.readyState === OPEN_STATE) {
      client.send(JSON.stringify(toBattleEventWire(roomId, event)))
    }
  }

  private codeFor(error: unknown, command: ParsedEpicCommand): string {
    if (error instanceof RoomNotFoundError) return EpicRejectionCode.RoomNotFound
    if (error instanceof RoomAccessForbiddenError) return EpicRejectionCode.NotAParticipant
    if (error instanceof InvalidCommandIdError) return EpicRejectionCode.InvalidCommandId
    if (error instanceof BattleNotInProgressError) return EpicRejectionCode.BattleNotActive
    if (error instanceof NotYourTurnError) return EpicRejectionCode.NotYourTurn
    if (error instanceof RoomConflictError) return EpicRejectionCode.CommandConflict

    if (
      error instanceof InvalidTargetError ||
      error instanceof SameTeamTargetError ||
      error instanceof InvalidHealTargetError ||
      error instanceof TargetUnavailableError ||
      error instanceof ActorUnavailableError ||
      error instanceof UnsupportedCombatProfileError ||
      error instanceof SkillsNotAvailableError ||
      error instanceof NoEpicEquippedError ||
      error instanceof EpicOnCooldownError ||
      error instanceof EpicTargetRequiredError
    ) {
      return error.code
    }

    if (error instanceof UnsupportedEpicEffectError) {
      // El motivo (`reason`) es para el registro: nunca viaja al cliente.
      this.logger.info('realtime_epica_no_soportada', {
        roomId: command.roomId,
        commandId: command.commandId,
        reason: error.reason,
      })

      return error.code
    }

    this.logger.error('realtime_epica_fallo', {
      roomId: command.roomId,
      commandId: command.commandId,
      error: error instanceof Error ? error.name : 'desconocido',
    })

    return EpicRejectionCode.InternalError
  }

  private reject(client: RealtimeSocket, code: string, commandId: string | undefined): void {
    if (client.readyState !== OPEN_STATE) {
      return
    }

    client.send(
      JSON.stringify({
        type: 'command.rejected',
        command: USE_EPIC_COMMAND,
        ...(commandId === undefined ? {} : { commandId }),
        code,
      }),
    )
  }
}
