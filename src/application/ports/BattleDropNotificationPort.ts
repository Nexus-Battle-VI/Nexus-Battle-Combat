import type { BattleDropTransferReceipt } from './BattleDropInventoryPort'

export interface BattleDropNotificationCommand {
  readonly receipt: BattleDropTransferReceipt
  readonly recipientId: string
  readonly role: 'GAINED' | 'LOST'
}

export interface BattleDropNotificationPort {
  notify(command: BattleDropNotificationCommand): Promise<void>
}

export const BATTLE_DROP_NOTIFIER = Symbol('BattleDropNotifier')
