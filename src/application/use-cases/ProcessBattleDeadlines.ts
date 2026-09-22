import { BattleRoomStatus } from '../../domain/value-objects/BattleRoomStatus'
import type { BattleDeadlineBookPort } from '../ports/BattleDeadlineBookPort'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { RoomCommandLockPort } from '../ports/RoomCommandLockPort'
import type { BattleDeadlineSettler } from '../services/BattleDeadlineSettler'

/**
 * Procesa los vencimientos de UNA sala (HU-21): lo llama el barrido del
 * planificador (`IntervalBattleDeadlineScheduler`) para cada sala cuyo
 * vencimiento ya llego.
 *
 * Toma el cerrojo de la sala con el mismo protocolo que los comandos de
 * combate: el barrido y una accion nunca escriben a la vez. La liquidacion en
 * si la hace `BattleDeadlineSettler` (una escritura, publicacion despues de
 * persistir y efectos de fin si corresponde).
 *
 * Una sala que ya no existe o que no esta `IN_BATTLE` no tiene vencimientos que
 * procesar: se cancela su registro y se sale sin escribir nada.
 */
export class ProcessBattleDeadlines {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly book: BattleDeadlineBookPort,
    private readonly lock: RoomCommandLockPort,
    private readonly settler: BattleDeadlineSettler,
  ) {}

  execute(roomId: string): Promise<void> {
    return this.lock.run(roomId, async () => {
      const room = await this.rooms.findById(roomId)

      if (room?.status !== BattleRoomStatus.InBattle) {
        this.book.cancel(roomId)

        return
      }

      await this.settler.settle(room)
    })
  }
}
