/**
 * Errores de la integracion Combat -> Wallet / Player-Inventory de HU-22
 * (`hu-22-reward-contract-v1`). Mismo criterio que `UpstreamErrors.ts`:
 * distinguen un resultado de NEGOCIO (Wallet/Inventory respondieron, con un
 * resultado que no es exito) de un fallo de TRANSPORTE (`UpstreamServiceError`,
 * reutilizada tal cual).
 */

/**
 * `409`: el mismo `operationId` ya se uso con un cuerpo distinto. Con
 * `operationId` determinista (`battle:{battleId}:player:{playerId}:...`) no
 * deberia ocurrir en operacion normal; si ocurre es una anomalia (colision de
 * datos o un defecto), no un fallo transitorio. Combat lo trata como
 * `TERMINAL_FAILURE`: reintentar con el mismo cuerpo no lo resuelve.
 */
export class RewardOperationConflictError extends Error {
  readonly service: string

  constructor(service: string, operationId: string) {
    super(`El operationId "${operationId}" ya se uso con otra solicitud en "${service}".`)
    this.name = 'RewardOperationConflictError'
    this.service = service
  }
}

/**
 * `422`: rechazo terminal de negocio (monto de Wallet fuera del catalogo
 * cerrado, o `INVENTORY_REJECTED` de Player-Inventory). `TERMINAL_FAILURE`:
 * no se reintenta solo.
 */
export class RewardRejectedError extends Error {
  readonly service: string
  readonly code: string | null

  constructor(service: string, message: string, code: string | null) {
    super(message)
    this.name = 'RewardRejectedError'
    this.service = service
    this.code = code
  }
}

/**
 * `4xx` PERMANENTE que no es 409 ni 422 (p. ej. `400` porque el destino no
 * acepta la forma del cuerpo). Reintentar el MISMO cuerpo no puede cambiar la
 * respuesta: solo un cambio de codigo lo arregla. Tratarlo como transitorio
 * (`UpstreamServiceError`) hizo que un `400` de Player-Inventory se reintentara
 * mas de 26 000 veces, una por segundo, sin llegar nunca a un estado terminal.
 *
 * Extiende `RewardRejectedError` a proposito: `ProcessRewardWorkflow` ya lo
 * lleva a `TERMINAL_FAILURE` (contrato §8.1, "422 u otro rechazo terminal"),
 * y `name` lo distingue en el registro de un rechazo de negocio.
 *
 * `detail` es el mensaje de validacion del destino, acotado y sin valores del
 * cuerpo; nunca el cuerpo completo.
 */
export class RewardInvalidRequestError extends RewardRejectedError {
  readonly status: number

  constructor(service: string, status: number, detail: string | null) {
    super(
      service,
      `"${service}" respondio HTTP ${String(status)} y no aceptara la misma peticion al reintentarla${detail === null ? '' : `: ${detail}`}.`,
      `HTTP_${String(status)}`,
    )
    this.name = 'RewardInvalidRequestError'
    this.status = status
  }
}
