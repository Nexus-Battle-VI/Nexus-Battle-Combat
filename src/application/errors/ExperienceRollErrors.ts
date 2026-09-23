/**
 * Errores del contrato interno de tiradas de experiencia (HU-09, Task HU-09.2).
 *
 * Son errores de CONTRATO, no de transporte: describen una peticion que no se
 * puede atender, y cada uno tiene su codigo en `hu-09-experience-reward-v1` §5.2.
 * Se separan del resto de errores de dominio porque su traduccion a HTTP vive en
 * el controlador y conviene que sea uno a uno.
 */

/**
 * `422 DUPLICATE_DEFEAT`: la misma instancia aparece dos veces en el lote.
 *
 * Es un defecto del llamante, no un reintento: dos entradas de la misma derrota
 * producirian dos tiradas y dos recompensas por un solo hecho. Se rechaza entero
 * en lugar de deduplicar en silencio, para que el error se vea.
 */
export class DuplicateDefeatError extends Error {
  readonly defeatKey: string

  constructor(defeatKey: string) {
    super(`La derrota "${defeatKey}" aparece dos veces en el mismo lote.`)
    this.name = 'DuplicateDefeatError'
    this.defeatKey = defeatKey
  }
}

/**
 * `400 SCHEMA_INVALID`: el cuerpo no cumple el contrato.
 *
 * Incluye el lote VACIO: una peticion sin derrotas no tiene nada que resolver, y
 * el contrato exige al menos una. Devolver `200` con una lista vacia dejaria al
 * llamante creyendo que si hizo algo.
 */
export class InvalidExperienceRollRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidExperienceRollRequestError'
  }
}

/**
 * `409 OPERATION_ID_REUSED`: el mismo `operationId` con OTRA lista de derrotas.
 *
 * Con un `operationId` determinista (`mission:{enrollmentId}:xp-rolls`) no
 * deberia ocurrir en operacion normal; si ocurre es una anomalia -- colision de
 * datos o un defecto --, y reintentar con el mismo cuerpo no la resuelve. Nunca
 * se sobrescribe el lote guardado: devolver tiradas nuevas por un lote que ya
 * existe seria regalar recompensas distintas por el mismo hecho.
 */
export class ExperienceRollOperationReusedError extends Error {
  readonly operationId: string

  constructor(operationId: string) {
    super(`El operationId "${operationId}" ya se uso con otra lista de derrotas.`)
    this.name = 'ExperienceRollOperationReusedError'
    this.operationId = operationId
  }
}
