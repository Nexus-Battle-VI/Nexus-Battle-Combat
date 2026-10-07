import type {
  BattleDropNotificationCommand,
  BattleDropNotificationPort,
} from '../../../application/ports/BattleDropNotificationPort'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import { postInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

export class NotificationsBattleDropHttpClient implements BattleDropNotificationPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async notify(command: BattleDropNotificationCommand): Promise<void> {
    const { receipt } = command
    const result = await postInternalJson(
      'notifications',
      '/api/internal/v1/notifications/combat/drop',
      {
        battleId: receipt.battleId,
        defeatEventSeq: receipt.defeatEventSeq,
        role: command.role,
        recipientId: command.recipientId,
        productInstanceId: receipt.productInstanceId,
        productId: receipt.productId,
        itemId: receipt.itemId,
        creditedAt: receipt.creditedAt,
      },
      this.options,
    )
    if (result.outcome !== 'ok') throw new UpstreamServiceError('notifications', result.outcome)
  }
}
