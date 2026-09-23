import { Controller, Get, Inject } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import type { BattleRoomDto } from '../../../application/dto/BattleRoomDto'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { ListMyActiveBattleRooms } from '../../../application/use-cases/ListMyActiveBattleRooms'
import { CurrentIdentity } from './auth/decorators'
import { BattleRoomResponse } from './battle-room.dto'
import { LIST_MY_ACTIVE_BATTLE_ROOMS } from './tokens'

/**
 * Salas activas del jugador autenticado, para "volver a mi sala" en Jugar
 * Online.
 *
 * Controlador propio (`v1/combat/me`) para no competir con
 * `v1/combat/rooms/:roomId` y su `ParseUUIDPipe`. Como el resto del servicio,
 * nace protegido por el `JwtAuthGuard` global: el jugador sale del testimonio
 * verificado, nunca de la URL, la consulta ni el cuerpo.
 */
@ApiTags('battle-rooms')
@ApiBearerAuth()
@Controller('v1/combat/me')
export class MyBattleRoomsController {
  constructor(
    @Inject(LIST_MY_ACTIVE_BATTLE_ROOMS)
    private readonly listMyActiveBattleRooms: ListMyActiveBattleRooms,
  ) {}

  @Get('rooms')
  @ApiOperation({
    summary:
      'Salas del jugador autenticado en WAITING_FOR_PLAYERS, PREPARING o IN_BATTLE, de la mas reciente a la mas antigua',
  })
  @ApiResponse({ status: 200, type: BattleRoomResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  async list(@CurrentIdentity() identity: VerifiedIdentity): Promise<readonly BattleRoomDto[]> {
    return this.listMyActiveBattleRooms.execute(identity.subject)
  }
}
