/**
 * Combat -> Player-Inventory, `POST /api/internal/v1/inventory/grants`
 * (hu-22-reward-contract-v1 §7). Reutiliza SIN CAMBIAR DE FORMA el contrato
 * ya implementado de HU-59/HU-69: un lote de un unico producto.
 */
export interface RewardGrantCommand {
  readonly operationId: string
  readonly playerId: string
  readonly productId: string
  readonly quantity: number
}

export interface RewardGrantResult {
  readonly applied: boolean
}

export interface RewardGrantPort {
  grant(command: RewardGrantCommand): Promise<RewardGrantResult>
}
