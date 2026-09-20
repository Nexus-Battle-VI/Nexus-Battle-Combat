import { DomainError } from '../errors/DomainError'

/**
 * Recurso Poder de UN heroe en batalla (HU-11 / RF-11).
 *
 * ESPEJO A PROPOSITO de `HeroPowerPolicy` de Nexus-Battle-Player-Inventory
 * (`src/domain/policies/HeroPowerPolicy.ts`, cuya especificacion es su
 * `docs/hu-11-power.md`). Combat es otro contexto y ADR-001 no permite
 * compartir codigo entre repositorios, asi que la regla se reimplementa aqui y
 * se mantiene alineada mediante los mismos vectores de prueba
 * (`test/unit/hero-power-policy.spec.ts`). Si la regla cambia, cambia en los dos
 * repositorios y en esos vectores.
 *
 * Funciones puras sobre un estado inmutable: ninguna muta su entrada, ninguna
 * guarda estado entre llamadas y ninguna recibe dos heroes a la vez. El Poder
 * pertenece al heroe (`heroId` viaja dentro del estado), nunca al jugador, asi que
 * mezclar el saldo de dos heroes no es una situacion representable aqui.
 *
 * Combat es quien conserva el estado durante la batalla y decide CUANDO llega un
 * turno o termina el combate; este modulo solo aplica la regla. El maximo NO se
 * calcula aqui: es `effectiveStats.power` del heroe equipado (ver
 * `PlayerInventoryEquippedHeroPort`) y se pasa a `createHeroPower`.
 *
 * ATENCION AL AGREGADO DE BATALLA: dos participantes pueden llevar el mismo heroe
 * de Catalog (por ejemplo, ambos jugadores de un JcJ con Guerrero Tanque). La
 * clave con la que el agregado guarde cada estado, y el `heroId` que le pase a
 * `createHeroPower`, debe ser unica POR PARTICIPANTE y no el id del producto, o
 * dos participantes compartirian saldo.
 */

/** RF-11: cantidad exacta que se recupera por turno durante el combate. */
export const POWER_REGEN_PER_TURN = 2 as const

export interface HeroPowerState {
  readonly heroId: string
  readonly current: number
  readonly max: number
}

export type HeroPowerCost =
  | { readonly mode: 'NONE' }
  | { readonly mode: 'FIXED'; readonly amount: number }
  | { readonly mode: 'ALL_AVAILABLE' }

export type PowerActionExecution = 'EXECUTED' | 'CANCELLED' | 'INVALID'

export type SpendPowerResult =
  | {
      readonly ok: true
      readonly spent: number
      readonly state: HeroPowerState
    }
  | {
      readonly ok: false
      readonly reason: 'insufficient' | 'not_executed'
      readonly fallbackAction: 'basic_attack' | null
      readonly spent: 0
      readonly state: HeroPowerState
    }

const validateInteger = (value: number, field: string): void => {
  if (!Number.isInteger(value)) {
    throw new DomainError(`${field} debe ser un entero. Se recibio ${String(value)}.`)
  }
}

export const validatePowerState = (state: HeroPowerState): HeroPowerState => {
  // El tipo dice `string`, pero el estado lo entrega el contexto de combate: un
  // `heroId` ausente debe ser un DomainError y no un TypeError al recortarlo.
  const rawHeroId: unknown = state.heroId
  if (typeof rawHeroId !== 'string' || rawHeroId.trim().length === 0) {
    throw new DomainError('El Poder debe estar asociado a un heroe.')
  }
  const heroId = rawHeroId.trim()

  validateInteger(state.max, 'El Poder maximo')
  validateInteger(state.current, 'El Poder actual')

  if (state.max < 0) {
    throw new DomainError('El Poder maximo no puede ser negativo.')
  }

  if (state.current < 0 || state.current > state.max) {
    throw new DomainError('El Poder actual debe estar entre cero y el maximo del heroe.')
  }

  return { ...state, heroId }
}

interface ResolvedCost {
  /** Puntos que se descontarian si la accion llega a ejecutarse. */
  readonly amount: number
  /** Si el saldo actual alcanza para pagarlos. Fuente unica de la regla. */
  readonly payable: boolean
}

/**
 * Traduce el costo publicado por Catalog a puntos concretos para un saldo dado.
 *
 * `payable` implica `amount <= state.current`, y de ahi sale la garantia de que
 * descontar nunca deja el saldo por debajo de cero.
 */
const resolveCost = (cost: unknown, state: HeroPowerState): ResolvedCost => {
  if (typeof cost !== 'object' || cost === null || !('mode' in cost)) {
    throw new DomainError('El costo de Poder debe declarar un modo valido.')
  }

  switch (cost.mode) {
    case 'NONE':
      return { amount: 0, payable: true }
    case 'ALL_AVAILABLE':
      // "Todos los puntos de poder" (Tabla 7, Reanimacion). Una accion que consume
      // Poder consume al menos un punto: con saldo cero no hay nada que consumir y
      // no se ejecuta gratis. La HU no define este borde; queda como decision
      // abierta en docs/hu-11-power.md.
      return { amount: state.current, payable: state.current > 0 }
    case 'FIXED': {
      if (!('amount' in cost) || typeof cost.amount !== 'number') {
        throw new DomainError('El costo fijo de Poder debe declarar un monto numerico.')
      }
      validateInteger(cost.amount, 'El costo fijo de Poder')
      if (cost.amount <= 0) {
        throw new DomainError('El costo fijo de Poder debe ser mayor que cero.')
      }
      return { amount: cost.amount, payable: cost.amount <= state.current }
    }
    default:
      throw new DomainError('El modo de costo de Poder no es valido.')
  }
}

const validateExecution = (execution: unknown): void => {
  if (execution !== 'EXECUTED' && execution !== 'CANCELLED' && execution !== 'INVALID') {
    throw new DomainError(`El estado de ejecucion "${String(execution)}" no es valido.`)
  }
}

/**
 * Estado inicial del Poder de un heroe al empezar un combate: su maximo.
 *
 * El maximo NO se decide aqui. Lo aporta quien conoce al heroe: en este servicio
 * es `effectiveStats.power` (HU-28), que parte de `basePower` de Catalog y suma
 * los modificadores permanentes del equipamiento; es el mismo valor que HU-15
 * entrega a Combat. La tabla de nivel 1 no define una formula para niveles
 * superiores y aqui no se inventa ninguna.
 *
 * Arranca completo porque el fin de cualquier combate restaura el Poder por
 * completo (RF-11) y la HU no define un valor inicial distinto.
 */
export const createHeroPower = (heroId: string, maxPower: number): HeroPowerState =>
  validatePowerState({ heroId, current: maxPower, max: maxPower })

/** Poder disponible ahora. Valida el estado antes de responder. */
export const getPower = (state: HeroPowerState): number => validatePowerState(state).current

/** Maximo permitido para el heroe. Valida el estado antes de responder. */
export const getMaxPower = (state: HeroPowerState): number => validatePowerState(state).max

/**
 * Pregunta previa, sin consumir nada: si el saldo cubre el costo. RF-11 exige
 * conocer el Poder disponible antes de permitir una accion que lo consuma, y la
 * IA de Misiones lo evalua como "disponibilidad de poder suficiente" antes de
 * elegir una rotacion. No decide la accion de reemplazo; eso lo hace `spendPower`.
 */
export const canAfford = (state: HeroPowerState, cost: HeroPowerCost): boolean =>
  resolveCost(cost, validatePowerState(state)).payable

/**
 * Resuelve el consumo una vez que el contexto de combate conoce el resultado
 * de la accion. La funcion es pura: devuelve un estado nuevo y el original
 * queda intacto, de modo que el nuevo saldo es el que valida la siguiente accion.
 *
 * Precedencia, en este orden:
 * 1. Accion cancelada o invalida (`CANCELLED`/`INVALID`): nunca descuenta y no
 *    afirma ninguna accion de reemplazo, ni siquiera si el costo era impagable.
 * 2. Costo impagable: la habilidad no se ejecuta, el saldo no cambia y se fuerza
 *    el ataque basico, que no consume Poder.
 * 3. Costo pagable: se descuenta exactamente el costo.
 */
export const spendPower = (
  state: HeroPowerState,
  cost: HeroPowerCost,
  execution: PowerActionExecution = 'EXECUTED',
): SpendPowerResult => {
  const validState = validatePowerState(state)
  const resolved = resolveCost(cost, validState)
  validateExecution(execution)

  if (execution !== 'EXECUTED') {
    return {
      ok: false,
      reason: 'not_executed',
      fallbackAction: null,
      spent: 0,
      state: validState,
    }
  }

  if (!resolved.payable) {
    return {
      ok: false,
      reason: 'insufficient',
      fallbackAction: 'basic_attack',
      spent: 0,
      state: validState,
    }
  }

  return {
    ok: true,
    spent: resolved.amount,
    state: { ...validState, current: validState.current - resolved.amount },
  }
}

/** Aplica la unica regeneracion definida por RF-11: +2 por turno. */
export const regenPower = (state: HeroPowerState): HeroPowerState => {
  const validState = validatePowerState(state)
  return {
    ...validState,
    current: Math.min(validState.max, validState.current + POWER_REGEN_PER_TURN),
  }
}

/** Restaura el recurso al maximo al finalizar cualquier combate. */
export const restorePower = (state: HeroPowerState): HeroPowerState => {
  const validState = validatePowerState(state)
  return { ...validState, current: validState.max }
}
