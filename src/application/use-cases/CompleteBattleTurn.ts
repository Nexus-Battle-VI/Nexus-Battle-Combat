import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import { RoomConflictError, RoomNotFoundError } from '../errors/ApplicationError'
import type { BattleEventPublisherPort } from '../ports/BattleEventPublisherPort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { BattleRoom } from '../../domain/entities/BattleRoom'

/** Reintentos ante un conflicto de version (otra escritura entre la lectura y el guardado). */
const MAX_ATTEMPTS = 3

export interface CompleteBattleTurnInput {
  readonly roomId: string
  /** Participante que cierra su turno; `null` cuando el turno activo es de un `AI` (lo cierra el servidor). */
  readonly actorPlayerId: string | null
  /** Identificador del comando (ADR-020): repetirlo devuelve el resultado ya calculado. */
  readonly commandId: string
}

export interface CompleteBattleTurnResult {
  readonly room: BattleRoom
  readonly event: BattleEvent
  readonly replayed: boolean
}

/**
 * Cierra el turno activo y avanza al siguiente elemento de la cola (HU-17,
 * RF-17: "al finalizar correctamente el turno de un participante, el sistema
 * debe avanzar al siguiente elemento de la cola").
 *
 * ES UN CASO DE USO DE SERVIDOR, NO UNA RUTA PUBLICA: lo invocaran las acciones
 * validas (HU-18 ataque, HU-19 habilidad) al terminar. Ningun controlador ni
 * mensaje de WebSocket lo expone, asi que Web no puede saltarse turnos.
 *
 * - Solo el participante de la posicion activa puede cerrarlo (`NotYourTurnError`).
 * - IDEMPOTENTE por `commandId` (ADR-020): repetirlo no avanza dos veces ni
 *   emite dos eventos.
 * - CONCURRENCIA: guarda con bloqueo optimista. Ante un conflicto relee y
 *   reevalua (max. 3 intentos): un `commandId` duplicado se resuelve como
 *   repeticion y otra accion concurrente que ya avanzo el turno falla con
 *   `NotYourTurnError`; nunca se avanza dos veces.
 * - Persiste ANTES de difundir `turnAdvanced`.
 */
export class CompleteBattleTurn {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly clock: ClockPort,
    private readonly publisher: BattleEventPublisherPort,
  ) {}

  async execute(input: CompleteBattleTurnInput): Promise<BattleRoomDto> {
    const result = await this.executeExclusively(input)

    if (!result.replayed) {
      try {
        this.publisher.publish(result.room.id, [result.event])
      } catch {
        // El estado ya esta persistido; un cliente que se pierda el evento usa `resume`.
      }
    }

    return toBattleRoomDto(result.room)
  }

  /**
   * Cierra el turno sin publicar. La ruta AI la usa dentro del lock de sala y
   * difunde despues mediante el mismo orden persistir -> publicar.
   */
  async executeExclusively(input: CompleteBattleTurnInput): Promise<CompleteBattleTurnResult> {
    for (let attempt = 1; ; attempt += 1) {
      const room = await this.rooms.findById(input.roomId)

      if (room === null) {
        throw new RoomNotFoundError(input.roomId)
      }

      const next = room.completeTurn(input.actorPlayerId, input.commandId, this.clock.now())

      if (next === room) {
        const handled = room.handledCommands.find(
          (candidate) => candidate.commandId === input.commandId,
        )
        const event =
          handled === undefined
            ? undefined
            : room.events.find((candidate) => candidate.seq === handled.seq)

        if (event === undefined) throw new RoomConflictError(input.roomId)
        return { room, event, replayed: true }
      }

      try {
        const saved = await this.rooms.save(next, room.version)
        const event = saved.events[saved.events.length - 1]

        if (event === undefined) throw new RoomConflictError(input.roomId)

        return { room: saved, event, replayed: false }
      } catch (error: unknown) {
        if (!(error instanceof RoomConflictError) || attempt >= MAX_ATTEMPTS) {
          throw error
        }
      }
    }
  }
}
