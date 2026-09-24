import type { BoundedRandom } from '../../domain/policies/TurnOrderPolicy'
import {
  defeatKeyOf,
  rollExperienceFor,
  type ExperienceRollDefeat,
} from '../../domain/reward/ExperienceRollPolicy'
import {
  DuplicateDefeatError,
  ExperienceRollOperationReusedError,
  InvalidExperienceRollRequestError,
} from '../errors/ExperienceRollErrors'
import type {
  ExperienceRollBatchSnapshot,
  ExperienceRollRecord,
  ExperienceRollRepositoryPort,
} from '../ports/ExperienceRollRepositoryPort'

/** Version del esquema del contrato interno que este caso de uso entiende. */
export const EXPERIENCE_ROLLS_SCHEMA_VERSION = 1

export interface ResolveExperienceRollsCommand {
  readonly schemaVersion: number
  /** `mission:{enrollmentId}:xp-rolls`, determinista. Lo calcula Missions. */
  readonly operationId: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly heroId: string
  readonly defeats: readonly ExperienceRollDefeat[]
}

export interface ResolveExperienceRollsResult {
  readonly operationId: string
  /** `false` cuando es un replay del mismo lote: se devuelven las MISMAS tiradas. */
  readonly applied: boolean
  readonly defeats: readonly ExperienceRollRecord[]
}

/**
 * Resuelve el lote de tiradas de experiencia de una mision (HU-09, Task HU-09.2;
 * `hu-09-experience-reward-v1` §5).
 *
 * QUE HACE, EN ESTE ORDEN, Y POR QUE EN ESE ORDEN.
 *   1. Valida el lote -- esquema, identificadores, al menos una derrota y
 *      ninguna instancia repetida --. Se valida ANTES de tocar el azar: un lote
 *      que no se puede atender no debe consumir el cursor.
 *   2. Mira si el `operationId` ya tiene lote guardado. Si lo tiene, NO TIRA:
 *      devuelve lo guardado. Es la garantia de que un reintento no produce una
 *      segunda recompensa por el mismo hecho.
 *   3. Solo si no existe, tira una vez por derrota con la fuente centralizada y
 *      persiste el lote ENTERO antes de responder.
 *
 * SIN FUENTE PROPIA. La instancia de azar llega inyectada (el token
 * `BATTLE_RANDOM`, la MISMA secuencia de proceso que turnos, ataques y cofre):
 * aqui no se construye ninguna secuencia. `ADR-021` da la exclusiva de la
 * aleatoriedad a Combat, y esta operacion es la unica puerta por la que Missions
 * la pide -- no acepta rango, no devuelve el indice ni la semilla.
 *
 * NO CONOCE LA FORMULA. Devuelve `1d8` por derrota; el importe de experiencia es
 * de Missions.
 *
 * LA CARRERA ES EXPLICITA. Si entre la comprobacion y la escritura otro proceso
 * guarda el mismo lote, `insertIfAbsent` devuelve `created: false` y se responde
 * con lo guardado. En ese caso el cursor se ha consumido de mas: es el precio de
 * no meter el azar dentro de la transaccion de escritura, y es inofensivo porque
 * la recompensa la fija el lote persistido, no el dado que se descarto.
 */
export class ResolveExperienceRolls {
  constructor(
    private readonly repository: ExperienceRollRepositoryPort,
    private readonly random: BoundedRandom,
  ) {}

  async execute(command: ResolveExperienceRollsCommand): Promise<ResolveExperienceRollsResult> {
    const defeats = validateDefeats(command)

    const stored = await this.repository.findById(command.operationId)

    if (stored !== null) {
      return replayOf(stored, defeats)
    }

    const rolled = rollExperienceFor(defeats, this.random)

    const { batch, created } = await this.repository.insertIfAbsent({
      operationId: command.operationId,
      enrollmentId: command.enrollmentId,
      simulationId: command.simulationId,
      heroId: command.heroId,
      defeats: rolled,
    })

    if (!created) {
      return replayOf(batch, defeats)
    }

    return { operationId: batch.operationId, applied: true, defeats: batch.defeats }
  }
}

/**
 * Respuesta a un lote que ya existia. Solo se acepta si es EL MISMO lote: misma
 * cantidad de derrotas y las mismas instancias en el mismo orden. Cualquier otra
 * cosa es el `409` del contrato, y nunca se devuelven tiradas nuevas.
 */
const replayOf = (
  batch: ExperienceRollBatchSnapshot,
  requested: readonly ExperienceRollDefeat[],
): ResolveExperienceRollsResult => {
  const storedKeys = batch.defeats.map(defeatKeyOf)
  const requestedKeys = requested.map(defeatKeyOf)

  if (storedKeys.length !== requestedKeys.length) {
    throw new ExperienceRollOperationReusedError(batch.operationId)
  }

  for (const [index, key] of storedKeys.entries()) {
    if (key !== requestedKeys[index]) {
      throw new ExperienceRollOperationReusedError(batch.operationId)
    }
  }

  return { operationId: batch.operationId, applied: false, defeats: batch.defeats }
}

/** Valida el contrato de entrada y devuelve las derrotas sin repeticiones. */
const validateDefeats = (
  command: ResolveExperienceRollsCommand,
): readonly ExperienceRollDefeat[] => {
  if (command.schemaVersion !== EXPERIENCE_ROLLS_SCHEMA_VERSION) {
    throw new InvalidExperienceRollRequestError(
      `schemaVersion debe ser ${String(EXPERIENCE_ROLLS_SCHEMA_VERSION)}.`,
    )
  }

  for (const [field, value] of [
    ['operationId', command.operationId],
    ['enrollmentId', command.enrollmentId],
    ['simulationId', command.simulationId],
    ['heroId', command.heroId],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidExperienceRollRequestError(`${field} es obligatorio.`)
    }
  }

  if (!Array.isArray(command.defeats) || command.defeats.length === 0) {
    throw new InvalidExperienceRollRequestError(
      'El lote necesita al menos una derrota: sin derrotas no hay nada que resolver.',
    )
  }

  const seen = new Set<string>()
  const defeats: ExperienceRollDefeat[] = []

  for (const entry of command.defeats as readonly unknown[]) {
    const defeat = parseDefeat(entry)
    const key = defeatKeyOf(defeat)

    if (seen.has(key)) {
      throw new DuplicateDefeatError(key)
    }

    seen.add(key)
    defeats.push(defeat)
  }

  return defeats
}

/**
 * Una derrota del cuerpo, leida como dato NO CONFIABLE.
 *
 * El tipo del comando dice lo que el contrato espera, no lo que llego: esto es
 * una frontera HTTP y quien llama es otro servicio. Se comprueba campo a campo
 * antes de devolver un valor con tipo, para que ni el azar ni la escritura vean
 * nunca un `undefined` disfrazado de cadena.
 */
const parseDefeat = (raw: unknown): ExperienceRollDefeat => {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidExperienceRollRequestError(
      'Cada derrota debe ser un objeto con encounterId, enemyInstanceId y rivalRef.',
    )
  }

  const entry = raw as Record<string, unknown>
  const fields: readonly (readonly [keyof ExperienceRollDefeat, unknown])[] = [
    ['encounterId', entry.encounterId],
    ['enemyInstanceId', entry.enemyInstanceId],
    ['rivalRef', entry.rivalRef],
  ]

  for (const [field, value] of fields) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidExperienceRollRequestError(
        `Cada derrota necesita ${field}: encounterId, enemyInstanceId y rivalRef son obligatorios.`,
      )
    }
  }

  return {
    encounterId: entry.encounterId as string,
    enemyInstanceId: entry.enemyInstanceId as string,
    rivalRef: entry.rivalRef as string,
  }
}
