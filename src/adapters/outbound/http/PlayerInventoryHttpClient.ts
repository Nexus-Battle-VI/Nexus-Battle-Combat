import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  EquippedHero,
  EquippedHeroAbility,
  EquippedHeroAbilityEffect,
  EquippedHeroBlocker,
  EquippedHeroEffect,
  EquippedHeroMagnitude,
  EquippedHeroPowerCost,
  EquippedHeroStats,
  PlayerInventoryEquippedHeroPort,
} from '../../../application/ports/PlayerInventoryEquippedHeroPort'
import { getInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'player-inventory'

/**
 * Cliente del contrato interno de Player-Inventory (HU-15.2, RF-15, DP-4;
 * HU-25): `GET /api/internal/v1/players/:playerId/equipped-hero`, protegido con
 * `@InternalOnly()` + `InternalServiceGuard` HMAC.
 *
 * Player-Inventory monta TODAS sus rutas -incluidas las internas
 * `@InternalOnly()`- bajo su prefijo global (`app.setGlobalPrefix(config.globalPrefix)`
 * en `Nexus-Battle-Player-Inventory/src/main.ts`, `GLOBAL_PREFIX=api` por
 * defecto, sin excepcion para el contrato interno): `/api` es, por tanto,
 * parte del contrato, igual que ya lo trata `AccountHttpClient` para Account
 * (mismo defecto, ya corregido alli en Combat PR#12). Corregido en la
 * auditoria HU-15.4 (hallazgo BLOQUEANTE-01): sin el prefijo, la peticion no
 * encontraba ninguna ruta y Player-Inventory respondia 404 de framework, que
 * este cliente interpretaba indistinguiblemente del 404 de negocio "sin
 * heroe equipado" (ver mas abajo) -- todo JOIN fallaba con
 * `PlayerWithoutEquippedHeroError`, tuviera o no el jugador un heroe real.
 *
 * PARSER ESTRICTO. El cuerpo se valida campo a campo y se reconstruye por lista
 * blanca; nunca se hace `body as EquippedHero`. Cualquier estructura que no
 * cumpla el contrato lanza `UpstreamServiceError(player-inventory,
 * respuesta_invalida)` (503): Combat no inventa estadisticas, efectos ni un
 * `[]` por defecto. En particular `activeEffects`, `abilities` (HU-19), `blockers` y
 * `loadoutVersion` son OBLIGATORIOS: sustituir `blockers` por `[]` cuando
 * falta haria que `PrecombatEligibilityPolicy` (HU-16.2) viera un heroe con
 * `ready=false` como si no tuviera ningun motivo declarado, y sustituir
 * `loadoutVersion` por `0` inventaria una version que Player-Inventory nunca
 * confirmo. Por eso el productor se despliega primero (ver
 * `docs/hu-25-effect-control-table.md` y `docs/hu-16-precombat-eligibility.md`).
 *
 * VALIDA LA FORMA, NO EL VOCABULARIO. `kind`, `target`, `statistic`,
 * `operation` y `subtype` deben ser texto no vacio, pero no se comparan con una
 * lista cerrada: el vocabulario lo posee Catalog/Player-Inventory y puede
 * crecer, y rechazarlo aqui bloquearia el ingreso a sala de quien lleve un
 * valor nuevo. Lo desconocido se clasifica mas adelante
 * (`assessEquipmentEffect`) y queda declarado como pendiente.
 *
 * Los campos extra del cuerpo se IGNORAN (contrato aditivo): no llegan al puerto.
 */
export class PlayerInventoryHttpClient implements PlayerInventoryEquippedHeroPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async getEquippedHero(playerId: string): Promise<EquippedHero | null> {
    const result = await getInternalJson(
      SERVICE,
      `/api/internal/v1/players/${encodeURIComponent(playerId)}/equipped-hero`,
      this.options,
    )

    // 404: el jugador no tiene ningun heroe equipado todavia. Camino de
    // negocio valido (a diferencia del 404 de Account) -- `JoinBattleRoom`
    // decide que hacer con `null`.
    if (!result.found) {
      return null
    }

    return parseEquippedHero(result.body, playerId)
  }
}

const invalidResponse = (): UpstreamServiceError =>
  new UpstreamServiceError(SERVICE, 'respuesta_invalida')

type UnknownRecord = Readonly<Record<string, unknown>>

const asRecord = (value: unknown): UnknownRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidResponse()
  }

  return value as UnknownRecord
}

const nonEmptyString = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidResponse()
  }

  return value
}

const requiredBoolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw invalidResponse()
  }

  return value
}

const nonNegativeInteger = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidResponse()
  }

  return value
}

const positiveInteger = (value: unknown): number => {
  const integer = nonNegativeInteger(value)

  if (integer === 0) {
    throw invalidResponse()
  }

  return integer
}

const isoInstant = (value: unknown): string => {
  const text = nonEmptyString(value)

  if (Number.isNaN(Date.parse(text))) {
    throw invalidResponse()
  }

  return text
}

/**
 * Magnitud `FIXED` | `PERCENTAGE` | `DICE`, con exactamente los campos de su
 * modo. No se convierte: un porcentaje sigue siendo `basisPoints` sin
 * interpretar su unidad.
 */
const parseMagnitude = (value: unknown): EquippedHeroMagnitude => {
  const record = asRecord(value)

  switch (record.mode) {
    case 'FIXED':
      return { mode: 'FIXED', amount: nonNegativeInteger(record.amount) }
    case 'PERCENTAGE':
      return { mode: 'PERCENTAGE', basisPoints: nonNegativeInteger(record.basisPoints) }
    case 'DICE':
      return {
        mode: 'DICE',
        count: nonNegativeInteger(record.count),
        sides: nonNegativeInteger(record.sides),
      }
    default:
      throw invalidResponse()
  }
}

const parseNullableMagnitude = (value: unknown): EquippedHeroMagnitude | null =>
  value === null ? null : parseMagnitude(value)

/**
 * Bloque de estadisticas. `attack`, `damage` y `healing` DEBEN venir (a `null`
 * cuando el heroe no los tiene): Player-Inventory los envia siempre, y un
 * ausente no se interpreta como `null`.
 */
const parseStats = (value: unknown): EquippedHeroStats => {
  const record = asRecord(value)

  return {
    power: nonNegativeInteger(record.power),
    health: nonNegativeInteger(record.health),
    defense: nonNegativeInteger(record.defense),
    attack: record.attack === null ? null : nonNegativeInteger(record.attack),
    damage: parseNullableMagnitude(record.damage),
    healing: parseNullableMagnitude(record.healing),
  }
}

/**
 * Los campos opcionales solo pueden AUSENTARSE, no venir a `null`: el
 * contrato omite lo que no tiene, y un `null` es una estructura malformada.
 */
const parseEffect = (value: unknown): EquippedHeroEffect => {
  const record = asRecord(value)

  return {
    sourceProductId: nonEmptyString(record.sourceProductId),
    sourceProductReference: nonEmptyString(record.sourceProductReference),
    kind: nonEmptyString(record.kind),
    target: nonEmptyString(record.target),
    ...(record.statistic === undefined ? {} : { statistic: nonEmptyString(record.statistic) }),
    ...(record.operation === undefined ? {} : { operation: nonEmptyString(record.operation) }),
    ...(record.magnitude === undefined ? {} : { magnitude: parseMagnitude(record.magnitude) }),
    ...(record.durationTurns === undefined
      ? {}
      : { durationTurns: positiveInteger(record.durationTurns) }),
    hasActivationCondition: requiredBoolean(record.hasActivationCondition),
    appliedToStats: requiredBoolean(record.appliedToStats),
  }
}

const parseActiveEffects = (value: unknown): readonly EquippedHeroEffect[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse()
  }

  return value.map(parseEffect)
}

/**
 * Efecto de una habilidad (HU-19): mismos campos opcionales que un efecto de equipamiento
 * (solo pueden AUSENTARSE), sin procedencia ni `appliedToStats`.
 */
const parseAbilityEffect = (value: unknown): EquippedHeroAbilityEffect => {
  const record = asRecord(value)

  return {
    kind: nonEmptyString(record.kind),
    target: nonEmptyString(record.target),
    ...(record.statistic === undefined ? {} : { statistic: nonEmptyString(record.statistic) }),
    ...(record.operation === undefined ? {} : { operation: nonEmptyString(record.operation) }),
    ...(record.magnitude === undefined ? {} : { magnitude: parseMagnitude(record.magnitude) }),
    ...(record.durationTurns === undefined
      ? {}
      : { durationTurns: positiveInteger(record.durationTurns) }),
    hasActivationCondition: requiredBoolean(record.hasActivationCondition),
  }
}

/** `FIXED` exige un entero >= 1 (igual que Catalog); `ALL_AVAILABLE` no lleva monto. */
const parsePowerCost = (value: unknown): EquippedHeroPowerCost => {
  const record = asRecord(value)

  if (record.mode === 'ALL_AVAILABLE') {
    return { mode: 'ALL_AVAILABLE' }
  }

  if (record.mode === 'FIXED') {
    return { mode: 'FIXED', amount: positiveInteger(record.amount) }
  }

  throw invalidResponse()
}

const parseAbility = (value: unknown): EquippedHeroAbility => {
  const record = asRecord(value)

  if (!Array.isArray(record.effects)) {
    throw invalidResponse()
  }

  return {
    abilityId: nonEmptyString(record.abilityId),
    reference: nonEmptyString(record.reference),
    name: nonEmptyString(record.name),
    powerCost: parsePowerCost(record.powerCost),
    chargeTurns: positiveInteger(record.chargeTurns),
    effects: record.effects.map(parseAbilityEffect),
  }
}

/**
 * OBLIGATORIO, igual que `activeEffects`: no se sustituye por `[]` cuando falta. Un
 * `abilities` ausente significa que Player-Inventory aun no lo publica (despliegue mal
 * ordenado): se responde 503 en lugar de dejar al heroe sin habilidades en silencio.
 */
const parseAbilities = (value: unknown): readonly EquippedHeroAbility[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse()
  }

  return value.map(parseAbility)
}

const nullableNonEmptyString = (value: unknown): string | null =>
  value === null ? null : nonEmptyString(value)

/**
 * Motivo de bloqueo de readiness (HU-16.1/HU-16.2, DP-1/DP-7). `code` es
 * texto abierto, igual que `kind`/`target` de un efecto: el vocabulario lo
 * posee Player-Inventory (`HeroReadinessPolicy`) y puede crecer sin que este
 * parser deba reconocerlo para reenviarlo tal cual.
 */
const parseBlocker = (value: unknown): EquippedHeroBlocker => {
  const record = asRecord(value)

  return {
    code: nonEmptyString(record.code),
    slot: nullableNonEmptyString(record.slot),
    reference: nonEmptyString(record.reference),
    detail: nonEmptyString(record.detail),
  }
}

/**
 * OBLIGATORIO, igual que `activeEffects`: no se sustituye por `[]` cuando
 * falta. Un `blockers` ausente en un `ready=false` haria que
 * `PrecombatEligibilityPolicy` viera "no listo, sin motivo" -- exactamente
 * el caso que esa politica ya cubre con su propio blocker generico
 * (`HERO_NOT_READY`), pero solo debe ocurrir por un contrato real que aun no
 * declara motivos, nunca porque este parser lo trato como opcional.
 */
const parseBlockers = (value: unknown): readonly EquippedHeroBlocker[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse()
  }

  return value.map(parseBlocker)
}

const parseEquippedHero = (body: unknown, expectedPlayerId: string): EquippedHero => {
  const record = asRecord(body)

  if (typeof record.playerId !== 'string' || record.playerId !== expectedPlayerId) {
    throw invalidResponse()
  }

  // Poder maximo del heroe (HU-11): `effectiveStats.power`. Combat no lo da por
  // bueno a ciegas -- `parseStats` exige un entero no negativo --, y inventar un
  // valor por defecto le daria a un heroe un recurso que no tiene.
  const effectiveStats = parseStats(record.effectiveStats)

  return {
    playerId: record.playerId,
    heroId: nonEmptyString(record.heroId),
    reference: nonEmptyString(record.reference),
    subtype: nonEmptyString(record.subtype),
    baseStats: parseStats(record.baseStats),
    effectiveStats,
    maxPower: effectiveStats.power,
    activeEffects: parseActiveEffects(record.activeEffects),
    abilities: parseAbilities(record.abilities),
    ready: requiredBoolean(record.ready),
    blockers: parseBlockers(record.blockers),
    loadoutVersion: nonNegativeInteger(record.loadoutVersion),
    selectedAt: isoInstant(record.selectedAt),
  }
}
