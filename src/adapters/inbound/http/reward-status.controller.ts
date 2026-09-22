import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger'

import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { GetRewardStatus } from '../../../application/use-cases/GetRewardStatus'
import { CurrentIdentity } from './auth/decorators'
import { RewardStatusResponse } from './reward-status.dto'
import { GET_REWARD_STATUS } from './tokens'

/**
 * Estado de la recompensa de HU-22 para el jugador autenticado
 * (`hu-22-reward-contract-v1` §10). Siempre el PROPIO estado: `playerId` sale
 * del testimonio verificado, nunca de un parametro.
 *
 * No es realtime: es la via de recuperacion para un refresh o una
 * reconexion, igual que `GET /v1/combat/rooms/:roomId` ya lo es para
 * `BattleResult` (HU-21 §6.3). Web la reconsulta tras recibir
 * `battle-room.updated` (mismo patron que el chat revalidando acceso al
 * cerrarse la sala, HU-21 §8).
 */
@ApiTags('combat-rewards')
@ApiBearerAuth()
@Controller('v1/combat/rooms')
export class RewardStatusController {
  constructor(@Inject(GET_REWARD_STATUS) private readonly getRewardStatus: GetRewardStatus) {}

  @Get(':roomId/reward')
  @ApiOperation({ summary: 'Estado de creditos y cofre de HU-22 para el jugador autenticado' })
  @ApiOkResponse({ type: RewardStatusResponse })
  async status(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<RewardStatusResponse> {
    return this.getRewardStatus.execute(roomId, identity.subject)
  }
}
