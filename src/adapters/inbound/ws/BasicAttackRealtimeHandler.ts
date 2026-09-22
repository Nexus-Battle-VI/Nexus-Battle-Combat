import { toBattleEventWire } from '../../../application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../../application/errors/ApplicationError'
import type { ExecuteBasicAttack } from '../../../application/use-cases/ExecuteBasicAttack'
import type { BattleFinalizer } from '../../../application/services/BattleFinalizer'
import {
  ActorUnavailableError,
  BattleNotInProgressError,
  InvalidCommandIdError,
  InvalidTargetError,
  NotYourTurnError,
  SameTeamTargetError,
  TargetUnavailableError,
  UnsupportedCombatProfileError,
} from '../../../domain/errors/BattleErrors'
import type { BattleEvent } from '../../../domain/entities/BattleEvent'
import type { CombatantKey } from '../../../domain/entities/Combatant'
import type { Logger } from '../../../infrastructure/observability/logger'
import type { RealtimeSocket } from './RealtimeSocket'

/** Nombre del comando en el protocolo (ADR-020 lo llama `attack`; `useSkill` es de HU-19). */
export const BASIC_ATTACK_COMMAND = 'attack'

const OPEN_STATE = 1
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Codigos estables de `command.rejected` del ataque basico (contrato HU-18 v1, §9). */
export const AttackRejectionCode = Object.freeze({
  MalformedCommand: 'MALFORMED_COMMAND',
  InvalidCommandId: 'INVALID_COMMAND_ID',
  RoomNotFound: 'ROOM_NOT_FOUND',
  NotAParticipant: 'NOT_A_PARTICIPANT',
  BattleNotActive: 'BATTLE_NOT_ACTIVE',
  NotYourTurn: 'NOT_YOUR_TURN',
  CommandConflict: 'COMMAND_CONFLICT',
  InternalError: 'INTERNAL_ERROR',
} as const)

interface ParsedAttackCommand {
  readonly commandId: string
  readonly roomId: string
  readonly target: CombatantKey
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value)

  return own.length === keys.length && keys.every((key) => own.includes(key))
}

/**
 * Valida la FORMA del comando (contrato HU-18 v1, §2): exactamente `type`, `commandId`,
 * `roomId` y `target`. Cualquier clave de mas -- `attackValue`, `damage`, `attackerId`,
 * `targets`, `area`... -- hace el comando mal formado: no se ignora en silencio.
 * `target` es UN objeto `{teamLabel, seat}`, nunca un arreglo.
 *
 * Un `commandId` que es una cadena pero no tiene 1 a 100 caracteres NO es "mal
 * formado": lo rechaza el dominio como `INVALID_COMMAND_ID`.
 */
export const parseAttackCommand = (
  message: Record<string, unknown>,
): ParsedAttackCommand | null => {
  if (!hasExactlyKeys(message, ['type', 'commandId', 'roomId', 'target'])) {
    return null
  }

  const { commandId, roomId, target } = message

  if (typeof commandId !== 'string' || typeof roomId !== 'string' || !UUID_V4.test(roomId)) {
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

  return { commandId, roomId, target: { teamLabel, seat } }
}

/** Difunde eventos YA PERSISTIDOS a los participantes (lo aporta el gateway, que es el publicador). */
export type PublishBattleEvents = (roomId: string, events: readonly BattleEvent[]) => void

/**
 * Traduce el comando `attack` (HU-18) del WebSocket a `ExecuteBasicAttack` y sus errores
 * a `command.rejected` con un codigo estable. No decide ninguna regla de combate.
 *
 * El atacante es SIEMPRE el `sub` autenticado de la conexion. Un comando rechazado
 * responde SOLO a quien lo envio (`command.rejected {command, commandId?, code}`) y no
 * cambia nada. Un `commandId` repetido recibe de nuevo el evento ya persistido, solo
 * el remitente: nadie mas recibe nada.
 */
export class BasicAttackRealtimeHandler {
  constructor(
    private readonly attack: ExecuteBasicAttack,
    private readonly logger: Logger,
    /**
     * HU-21: efectos de la finalizacion, SIEMPRE despues de difundir (contrato
     * §8). Opcional para las construcciones de pruebas que no finalizan.
     */
    private readonly finalizer: BattleFinalizer | null = null,
  ) {}

  async handle(
    client: RealtimeSocket,
    subject: string,
    message: Record<string, unknown>,
    publish: PublishBattleEvents,
  ): Promise<void> {
    const command = parseAttackCommand(message)

    if (command === null) {
      const commandId = typeof message.commandId === 'string' ? message.commandId : undefined

      this.reject(client, AttackRejectionCode.MalformedCommand, commandId)
      return
    }

    try {
      const result = await this.attack.execute({
        roomId: command.roomId,
        requesterId: subject,
        commandId: command.commandId,
        target: command.target,
      })

      this.logger.info('realtime_attack_resuelto', {
        roomId: command.roomId,
        commandId: command.commandId,
        seq: result.event.seq,
        replayed: result.replayed,
      })

      if (result.replayed) {
        // Repeticion: el resultado ya esta persistido y difundido. Solo se le devuelve a
        // quien lo repite; nadie mas recibe nada y no se difunde otra vez.
        if (client.readyState === OPEN_STATE) {
          client.send(JSON.stringify(toBattleEventWire(command.roomId, result.event)))
        }

        return
      }

      // Persistido: ahora si se difunde. Un fallo aqui no revierte nada (el estado ya
      // existe y `resume` lo recupera). HU-21: se difunde PRIMERO la accion y despues
      // `battleFinished` (mismos bytes, `seq` consecutivos) y SOLO DESPUES se liberan
      // los recursos: si se liberara antes, las conexiones dejarian de recibir el final.
      try {
        publish(command.roomId, [result.event, ...result.followUp])
      } catch {
        this.logger.error('realtime_attack_difusion_fallo', {
          roomId: command.roomId,
          commandId: command.commandId,
        })
      }

      if (result.finished !== null) {
        this.finalizer?.afterFinished(result.finished)
      }
    } catch (error: unknown) {
      this.reject(client, this.codeFor(error, command), command.commandId)
    }
  }

  private codeFor(error: unknown, command: ParsedAttackCommand): string {
    if (error instanceof RoomNotFoundError) return AttackRejectionCode.RoomNotFound
    if (error instanceof RoomAccessForbiddenError) return AttackRejectionCode.NotAParticipant
    if (error instanceof InvalidCommandIdError) return AttackRejectionCode.InvalidCommandId
    if (error instanceof BattleNotInProgressError) return AttackRejectionCode.BattleNotActive
    if (error instanceof NotYourTurnError) return AttackRejectionCode.NotYourTurn
    if (error instanceof RoomConflictError) return AttackRejectionCode.CommandConflict

    if (
      error instanceof InvalidTargetError ||
      error instanceof SameTeamTargetError ||
      error instanceof TargetUnavailableError ||
      error instanceof ActorUnavailableError ||
      error instanceof UnsupportedCombatProfileError
    ) {
      return error.code
    }

    this.logger.error('realtime_attack_fallo', {
      roomId: command.roomId,
      commandId: command.commandId,
      error: error instanceof Error ? error.name : 'desconocido',
    })

    return AttackRejectionCode.InternalError
  }

  private reject(client: RealtimeSocket, code: string, commandId: string | undefined): void {
    if (client.readyState !== OPEN_STATE) {
      return
    }

    client.send(
      JSON.stringify({
        type: 'command.rejected',
        command: BASIC_ATTACK_COMMAND,
        ...(commandId === undefined ? {} : { commandId }),
        code,
      }),
    )
  }
}
