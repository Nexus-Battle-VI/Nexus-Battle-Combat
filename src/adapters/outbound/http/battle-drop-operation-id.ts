import { uuidV5 } from './inventory-grant-operation-id'

/** Namespace propio de HU-30; no compartir el ledger de grants/compromisos. */
export const BATTLE_DROP_NAMESPACE = 'b362c909-82ea-4f0e-9c6d-2cab82ad6eb1'

export const toBattleDropOperationId = (battleId: string, defeatEventSeq: number): string =>
  uuidV5(`battle:${battleId}:defeat:${String(defeatEventSeq)}:drop`, BATTLE_DROP_NAMESPACE)
