/**
 * Errores de la integracion Combat -> Wallet de HU-23 (apuestas). Mismo
 * criterio que `RewardIntegrationErrors.ts`: distinguen un resultado de
 * NEGOCIO (Wallet respondio, con un rechazo) de un fallo de TRANSPORTE
 * (`UpstreamServiceError`, reutilizada tal cual).
 */

/**
 * `409`: el mismo `operationId` ya se uso con un cuerpo distinto. Con los
 * `operationId` deterministas de HU-23 (`battle:{id}:player:{id}:stake:...`)
 * no deberia ocurrir en operacion normal: es una anomalia, no un fallo
 * transitorio. No se reintenta solo.
 */
export class StakeOperationConflictError extends Error {
  readonly service: string
  readonly operationId: string

  constructor(service: string, operationId: string) {
    super(`El operationId "${operationId}" ya se uso con otra solicitud en "${service}".`)
    this.name = 'StakeOperationConflictError'
    this.service = service
    this.operationId = operationId
  }
}

/**
 * `422`: rechazo terminal de negocio de Wallet. `code` es el del contrato
 * `hu-23-battle-stake-v1` §11 (`INSUFFICIENT_AVAILABLE_BALANCE`,
 * `INVALID_AMOUNT`, `HOLD_NOT_FOUND`, `SETTLEMENT_NOT_ZERO_SUM`,
 * `HOLD_AMOUNT_MISMATCH`). En `create`/`join` el rechazo se propaga con el
 * MISMO codigo (contrato §7); en la liquidacion es un bug de
 * `BattleStakePolicy` y no se reintenta solo (§9).
 */
export class StakeRejectedError extends Error {
  readonly service: string
  readonly code: string | null

  constructor(service: string, message: string, code: string | null) {
    super(message)
    this.name = 'StakeRejectedError'
    this.service = service
    this.code = code
  }
}
