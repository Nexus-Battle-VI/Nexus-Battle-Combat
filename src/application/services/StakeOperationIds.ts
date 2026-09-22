/**
 * `operationId` deterministas del contrato de apuestas (HU-23,
 * `hu-23-battle-stake-v1` §5). Son la CADENA LITERAL, sin hashear (mismo
 * criterio que `walletOperationIdOf` de HU-22): un reintento de la misma
 * operacion reutiliza el mismo id y Wallet lo reconoce como replay.
 */
export const stakeReserveOperationIdOf = (battleId: string, playerId: string): string =>
  `battle:${battleId}:player:${playerId}:stake:reserve`

export const stakeReleaseOperationIdOf = (battleId: string, playerId: string): string =>
  `battle:${battleId}:player:${playerId}:stake:release`

/** UNO por batalla (D10): el reparto completo viaja en un solo cuerpo. */
export const stakeSettleOperationIdOf = (battleId: string): string =>
  `battle:${battleId}:stakes:settle`
