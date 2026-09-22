import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import { RoomConflictError, RoomNotFoundError } from '../errors/ApplicationError'
import type { BattleEventPublisherPort } from '../ports/BattleEventPublisherPort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

/** Reintentos ante un conflicto de version (otra escritura entre la lectura y el guardado). */
const MAX_ATTEMPTS = 3

export interface CompleteBattleTurnInput {
  readonly roomId: string
  /** Participante que cierra su turno; `null` cuando el turno activo es de un `AI` (lo cierra el servidor). */
  readonly actorPlayerId: string | null
  /** Identificador del comando (ADR-020): repetirlo devuelve el resultado ya calculado. */
  readonly commandId: string
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
    for (let attempt = 1; ; attempt += 1) {
      const room = await this.rooms.findById(input.roomId)

      if (room === null) {
        throw new RoomNotFoundError(input.roomId)
      }

      const next = room.completeTurn(input.actorPlayerId, input.commandId, this.clock.now())

      if (next === room) {
        // `commandId` ya procesado: mismo resultado, sin persistir ni difundir.
        return toBattleRoomDto(room)
      }

      try {
        const saved = await this.rooms.save(next, room.version)
        const event = saved.events[saved.events.length - 1]

        if (event !== undefined) {
          try {
            this.publisher.publish(saved.id, [event])
          } catch {
            // El estado ya esta persistido; un cliente que se pierda el evento usa `resume`.
          }
        }

        return toBattleRoomDto(saved)
      } catch (error: unknown) {
        if (!(error instanceof RoomConflictError) || attempt >= MAX_ATTEMPTS) {
          throw error
        }
      }
    }
  }
}
