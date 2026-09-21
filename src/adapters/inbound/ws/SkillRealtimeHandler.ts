import { toBattleEventWire } from '../../../application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../../application/errors/ApplicationError'
import type { UseSkill } from '../../../application/use-cases/UseSkill'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  SkillOnCooldownError,
  SkillsNotAvailableError,
  TargetUnavailableError,
  UnknownSkillError,
  UnsupportedCombatProfileError,
  UnsupportedSkillEffectError,
} from '../../../domain/errors/BattleErrors'
import type { BattleEvent } from '../../../domain/entities/BattleEvent'
import type { CombatantKey } from '../../../domain/entities/Combatant'
import type { Logger } from '../../../infrastructure/observability/logger'
import type { PublishBattleEvents } from './BasicAttackRealtimeHandler'
import type { RealtimeSocket } from './RealtimeSocket'

/** Nombre del comando en el protocolo (ADR-020: `useSkill`; HU-18 lo reservo para HU-19). */
export const USE_SKILL_COMMAND = 'useSkill'

const OPEN_STATE = 1
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
/** `abilityId` es el `productId` de Catalog: un UUID de cualquier version. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** Codigos estables de `command.rejected` propios del handler (contrato HU-19 v1, §9). */
export const SkillRejectionCode = Object.freeze({
  MalformedCommand: 'MALFORMED_COMMAND',
  InvalidCommandId: 'INVALID_COMMAND_ID',
  RoomNotFound: 'ROOM_NOT_FOUND',
  NotAParticipant: 'NOT_A_PARTICIPANT',
  BattleNotActive: 'BATTLE_NOT_ACTIVE',
  NotYourTurn: 'NOT_YOUR_TURN',
  CommandConflict: 'COMMAND_CONFLICT',
  InternalError: 'INTERNAL_ERROR',
} as const)

interface ParsedSkillCommand {
  readonly commandId: string
  readonly roomId: string
  readonly abilityId: string
  readonly target: CombatantKey
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value)

  return own.length === keys.length && keys.every((key) => own.includes(key))
}

/**
 * Valida la FORMA del comando (contrato HU-19 v1, §2): exactamente `type`, `commandId`,
 * `roomId`, `abilityId` y `target`. Cualquier clave de mas -- `effects`, `cost`, `power`,
 * `cooldown`, `damage`, `attackBonus`, `targets`, `area`... -- hace el comando mal formado: no
 * se ignora en silencio. `target` es UN objeto `{teamLabel, seat}`, nunca un arreglo.
 *
 * Un `commandId` que es una cadena pero no tiene 1 a 100 caracteres NO es "mal formado": lo
 * rechaza el dominio como `INVALID_COMMAND_ID`.
 */
export const parseSkillCommand = (message: Record<string, unknown>): ParsedSkillCommand | null => {
  if (!hasExactlyKeys(message, ['type', 'commandId', 'roomId', 'abilityId', 'target'])) {
    return null
  }

  const { commandId, roomId, abilityId, target } = message

  if (
    typeof commandId !== 'string' ||
    typeof roomId !== 'string' ||
    !UUID_V4.test(roomId) ||
    typeof abilityId !== 'string' ||
    !UUID.test(abilityId)
  ) {
    return null
  }

  if (!isPlainRecord(target) || !hasExactlyKeys(target, ['teamLabel', 'seat'])) {
    return null
  }

  const { teamLabel, seat } = target

  if (
    typeof teamLabel !== 'string' ||
    teamLabel.length === 0 ||
    typeof seat !== 'number' ||
    !Number.isInteger(seat) ||
    seat < 0
  ) {
    return null
  }

  return { commandId, roomId, abilityId, target: { teamLabel, seat } }
}

/**
 * Traduce el comando `useSkill` (HU-19) del WebSocket a `UseSkill` y sus errores a
 * `command.rejected` con un codigo estable. No decide ninguna regla de combate.
 *
 * El actor es SIEMPRE el `sub` autenticado de la conexion. Un comando rechazado responde SOLO
 * a quien lo envio (`command.rejected {command, commandId?, code}`) y no cambia nada. Un
 * `commandId` repetido recibe de nuevo el evento ya persistido, solo el remitente: nadie mas
 * recibe nada. El Poder insuficiente NO es un rechazo: llega como el `basicAttackResolved` con
 * `degradedFrom` que devuelve el caso de uso.
 */
export class SkillRealtimeHandler {
  constructor(
    private readonly skill: UseSkill,
    private readonly logger: Logger,
  ) {}

  async handle(
    client: RealtimeSocket,
    subject: string,
    message: Record<string, unknown>,
    publish: PublishBattleEvents,
  ): Promise<void> {
    const command = parseSkillCommand(message)

    if (command === null) {
      const commandId = typeof message.commandId === 'string' ? message.commandId : undefined

      this.reject(client, SkillRejectionCode.MalformedCommand, commandId)
      return
    }

    try {
      const result = await this.skill.execute({
        roomId: command.roomId,
        requesterId: subject,
        commandId: command.commandId,
        abilityId: command.abilityId,
        target: command.target,
      })

      this.logger.info('realtime_habilidad_resuelta', {
        roomId: command.roomId,
        commandId: command.commandId,
        abilityId: command.abilityId,
        eventType: result.event.type,
        seq: result.event.seq,
        replayed: result.replayed,
      })

      if (result.replayed) {
        // Repeticion: el resultado ya esta persistido y difundido. Solo se le devuelve a quien
        // lo repite; nadie mas recibe nada y no se difunde otra vez.
        this.send(client, command.roomId, result.event)

        return
      }

      // Persistido: ahora si se difunde. Un fallo aqui no revierte nada (el estado ya existe y
      // `resume` lo recupera).
      try {
        publish(command.roomId, [result.event])
      } catch {
        this.logger.error('realtime_habilidad_difusion_fallo', {
          roomId: command.roomId,
          commandId: command.commandId,
        })
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

  private codeFor(error: unknown, command: ParsedSkillCommand): string {
    if (error instanceof RoomNotFoundError) return SkillRejectionCode.RoomNotFound
    if (error instanceof RoomAccessForbiddenError) return SkillRejectionCode.NotAParticipant
    if (error instanceof InvalidCommandIdError) return SkillRejectionCode.InvalidCommandId
    if (error instanceof BattleNotInProgressError) return SkillRejectionCode.BattleNotActive
    if (error instanceof NotYourTurnError) return SkillRejectionCode.NotYourTurn
    if (error instanceof RoomConflictError) return SkillRejectionCode.CommandConflict

    if (
      error instanceof InvalidTargetError ||
      error instanceof SameTeamTargetError ||
      error instanceof TargetUnavailableError ||
      error instanceof ActorUnavailableError ||
      error instanceof UnsupportedCombatProfileError ||
      error instanceof SkillsNotAvailableError ||
      error instanceof UnknownSkillError ||
      error instanceof SkillOnCooldownError
    ) {
      return error.code
    }

    if (error instanceof UnsupportedSkillEffectError) {
      // El motivo (`reason`) es para el registro: nunca viaja al cliente.
      this.logger.info('realtime_habilidad_no_soportada', {
        roomId: command.roomId,
        commandId: command.commandId,
        abilityId: command.abilityId,
        reason: error.reason,
      })

      return error.code
    }

    this.logger.error('realtime_habilidad_fallo', {
      roomId: command.roomId,
      commandId: command.commandId,
      error: error instanceof Error ? error.name : 'desconocido',
    })

    return SkillRejectionCode.InternalError
  }

  private reject(client: RealtimeSocket, code: string, commandId: string | undefined): void {
    if (client.readyState !== OPEN_STATE) {
      return
    }

    client.send(
      JSON.stringify({
        type: 'command.rejected',
        command: USE_SKILL_COMMAND,
        ...(commandId === undefined ? {} : { commandId }),
        code,
      }),
    )
  }
}
