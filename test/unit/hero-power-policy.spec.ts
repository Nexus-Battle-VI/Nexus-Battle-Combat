/**
 * VECTORES DE CONFORMIDAD con la regla de Poder de Nexus-Battle-Player-Inventory
 * (HU-11 / RF-11): este archivo es la copia de `test/unit/hero-power.spec.ts` de ese
 * repositorio, con los mismos casos y los mismos numeros. Combat no puede importar
 * codigo de otro repositorio (ADR-001), asi que la regla se reimplementa en
 * `src/domain/policies/HeroPowerPolicy.ts` y estas pruebas son lo que garantiza que
 * ambas implementaciones dicen lo mismo. Si la regla cambia, cambian los dos archivos.
 */
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  POWER_REGEN_PER_TURN,
  canAfford,
  createHeroPower,
  getMaxPower,
  getPower,
  regenPower,
  restorePower,
  spendPower,
  type HeroPowerCost,
  type HeroPowerState,
  type PowerActionExecution,
} from '../../src/domain/policies/HeroPowerPolicy'

const power = (heroId: string, current: number, max = 10): HeroPowerState => ({
  heroId,
  current,
  max,
})

const fixed = (amount: number): HeroPowerCost => ({ mode: 'FIXED', amount })
const NONE: HeroPowerCost = { mode: 'NONE' }
const ALL: HeroPowerCost = { mode: 'ALL_AVAILABLE' }

describe('HeroPowerPolicy — HU-11 / RF-11', () => {
  it('consulta y descuenta Poder cuando el saldo cubre exactamente el costo', () => {
    const before = power(' hero-a ', 6)
    const result = spendPower(before, fixed(6))

    expect(result).toEqual({ ok: true, spent: 6, state: power('hero-a', 0) })
    expect(getPower(result.state)).toBe(0)
    expect(before).toEqual(power(' hero-a ', 6))
  })

  it('el ataque básico no consume Poder', () => {
    expect(spendPower(power('hero-a', 3), { mode: 'NONE' })).toEqual({
      ok: true,
      spent: 0,
      state: power('hero-a', 3),
    })
  })

  it('rechaza una habilidad impagable, conserva el saldo y degrada a ataque básico', () => {
    const before = power('hero-a', 3)

    expect(spendPower(before, fixed(4))).toEqual({
      ok: false,
      reason: 'insufficient',
      fallbackAction: 'basic_attack',
      spent: 0,
      state: before,
    })
  })

  it('consume todo el Poder disponible para ALL_AVAILABLE', () => {
    expect(spendPower(power('medico', 7), { mode: 'ALL_AVAILABLE' })).toEqual({
      ok: true,
      spent: 7,
      state: power('medico', 0),
    })
  })

  it.each(['CANCELLED', 'INVALID'] as const)('no descuenta si la acción queda %s', (execution) => {
    const before = power('hero-a', 8)

    expect(spendPower(before, fixed(4), execution)).toEqual({
      ok: false,
      reason: 'not_executed',
      fallbackAction: null,
      spent: 0,
      state: before,
    })
  })

  it('regenera exactamente dos por turno sin superar el máximo', () => {
    expect(regenPower(power('hero-a', 5))).toEqual(power('hero-a', 7))
    expect(regenPower(power('hero-a', 9))).toEqual(power('hero-a', 10))
    expect(regenPower(power('hero-a', 10))).toEqual(power('hero-a', 10))
  })

  it('restaura por completo al finalizar el combate', () => {
    expect(restorePower(power('hero-a', 1))).toEqual(power('hero-a', 10))
  })

  it('mantiene aislado el Poder de dos héroes del mismo jugador', () => {
    const heroA = power('hero-a', 8)
    const heroB = power('hero-b', 8)

    expect(spendPower(heroA, fixed(3))).toEqual({
      ok: true,
      spent: 3,
      state: power('hero-a', 5),
    })
    expect(heroB).toEqual(power('hero-b', 8))
  })

  it.each([
    ['costo fijo cero', () => spendPower(power('hero-a', 5), fixed(0))],
    ['costo negativo', () => spendPower(power('hero-a', 5), fixed(-1))],
    ['costo decimal', () => spendPower(power('hero-a', 5), fixed(1.5))],
    ['costo no finito', () => spendPower(power('hero-a', 5), fixed(Number.NaN))],
    ['saldo negativo', () => getPower(power('hero-a', -1))],
    ['saldo sobre máximo', () => getPower(power('hero-a', 11))],
    ['saldo decimal', () => getPower(power('hero-a', 1.5))],
    ['máximo negativo', () => getPower(power('hero-a', 0, -1))],
    ['máximo decimal', () => getPower(power('hero-a', 0, 1.5))],
    ['héroe vacío', () => getPower(power(' ', 1))],
  ])('rechaza %s', (_case, action) => {
    expect(action).toThrow(DomainError)
  })

  it('rechaza modos de costo y estados de ejecución desconocidos en tiempo de ejecución', () => {
    expect(() =>
      spendPower(power('hero-a', 5), { mode: 'PERCENTAGE' } as unknown as HeroPowerCost),
    ).toThrow(DomainError)
    expect(() =>
      spendPower(power('hero-a', 5), { mode: 'FIXED' } as unknown as HeroPowerCost),
    ).toThrow(DomainError)
    expect(() =>
      spendPower(power('hero-a', 5), fixed(2), 'PENDING' as unknown as 'EXECUTED'),
    ).toThrow(DomainError)
  })
})

describe('HU-11 — consulta del Poder de un héroe concreto', () => {
  it('informa el Poder actual y el máximo de ese héroe', () => {
    expect(getPower(power('hero-a', 7))).toBe(7)
    expect(getMaxPower(power('hero-a', 7))).toBe(10)
    expect(getPower(power('hero-b', 3, 8))).toBe(3)
    expect(getMaxPower(power('hero-b', 3, 8))).toBe(8)
  })

  it('el Poder inicial de un héroe es su máximo, sea cual sea', () => {
    expect(createHeroPower('hero-a', 10)).toEqual(power('hero-a', 10, 10))
    expect(createHeroPower('hero-b', 8)).toEqual(power('hero-b', 8, 8))
  })

  it('un héroe sin Poder máximo es válido (Catalog admite basePower 0) y no puede pagar nada', () => {
    const empty = createHeroPower('hero-z', 0)

    expect(empty).toEqual(power('hero-z', 0, 0))
    expect(spendPower(empty, fixed(1))).toMatchObject({ ok: false, fallbackAction: 'basic_attack' })
    expect(regenPower(empty)).toEqual(empty)
    expect(restorePower(empty)).toEqual(empty)
  })
})

describe('HU-11 — consumo válido', () => {
  it.each([
    [10, 4, 6],
    [10, 10, 0],
    [10, 1, 9],
    [8, 8, 0],
    [5, 2, 3],
  ])('con %i de Poder y costo %i queda %i', (current, cost, expected) => {
    const result = spendPower(power('hero-a', current), fixed(cost))

    expect(result).toEqual({ ok: true, spent: cost, state: power('hero-a', expected) })
  })
})

describe('HU-11 — Poder insuficiente: la habilidad se bloquea y se fuerza el ataque básico', () => {
  it('con 3 de Poder y costo 4 no se ejecuta, se fuerza el básico y el saldo sigue en 3, no en 0', () => {
    const result = spendPower(power('hero-a', 3), fixed(4))

    expect(result).toEqual({
      ok: false,
      reason: 'insufficient',
      fallbackAction: 'basic_attack',
      spent: 0,
      state: power('hero-a', 3),
    })
    expect(result.state.current).not.toBe(0)
  })

  it.each([
    [0, 1],
    [3, 4],
    [9, 10],
    [10, 11],
  ])(
    'con %i de Poder no se paga un costo de %i (frontera: falta exactamente 1)',
    (current, cost) => {
      const before = power('hero-a', current)

      expect(spendPower(before, fixed(cost))).toEqual({
        ok: false,
        reason: 'insufficient',
        fallbackAction: 'basic_attack',
        spent: 0,
        state: before,
      })
      expect(canAfford(before, fixed(cost))).toBe(false)
    },
  )

  it.each([
    [1, 1],
    [3, 3],
    [4, 4],
    [10, 10],
  ])(
    'con %i de Poder sí se paga un costo de %i (frontera opuesta: no falta nada)',
    (current, cost) => {
      const before = power('hero-a', current)

      expect(canAfford(before, fixed(cost))).toBe(true)
      expect(spendPower(before, fixed(cost))).toMatchObject({
        ok: true,
        spent: cost,
        state: power('hero-a', 0),
      })
    },
  )
})

describe('HU-11 — el ataque básico no consume Poder', () => {
  it.each([10, 5, 1, 0])('con %i de Poder el ataque básico deja el mismo saldo', (current) => {
    const before = power('hero-a', current)

    expect(spendPower(before, NONE)).toEqual({ ok: true, spent: 0, state: before })
  })

  it('se puede usar con Poder cero: es justamente la acción de reemplazo', () => {
    expect(canAfford(power('hero-a', 0), NONE)).toBe(true)
  })
})

describe('HU-11 — acción cancelada, rechazada o no ejecutada', () => {
  it.each(['CANCELLED', 'INVALID'] as const)(
    'con 10 de Poder y costo 4, una acción %s deja 10',
    (execution) => {
      const before = power('hero-a', 10)
      const result = spendPower(before, fixed(4), execution)

      expect(result).toMatchObject({ ok: false, reason: 'not_executed', spent: 0 })
      expect(result.state).toEqual(before)
    },
  )

  it.each([
    ['costo fijo', fixed(4)],
    ['todo el Poder', ALL],
    ['ataque básico', NONE],
  ])('una acción cancelada con %s nunca descuenta', (_label, cost) => {
    const before = power('hero-a', 7)

    expect(spendPower(before, cost, 'CANCELLED').state).toEqual(before)
  })

  it('cancelar no cobra: tras cancelar un costo 4 con 10 aún se paga un costo 10', () => {
    const afterCancel = spendPower(power('hero-a', 10), fixed(4), 'CANCELLED').state

    // Control: si la cancelación hubiera cobrado 4 el saldo sería 6 y esto fallaría.
    expect(spendPower(afterCancel, fixed(10))).toMatchObject({ ok: true, spent: 10 })
  })

  it('una acción cancelada con costo impagable no afirma acción de reemplazo (precedencia)', () => {
    const before = power('hero-a', 3)

    expect(spendPower(before, fixed(4), 'CANCELLED')).toEqual({
      ok: false,
      reason: 'not_executed',
      fallbackAction: null,
      spent: 0,
      state: before,
    })
  })
})

describe('HU-11 — regeneración de +2 por turno con tope en el máximo', () => {
  it('la regeneración definida por RF-11 es exactamente 2', () => {
    expect(POWER_REGEN_PER_TURN).toBe(2)
  })

  it.each([
    [0, 2],
    [2, 4],
    [3, 5],
    [8, 10],
    [9, 10],
    [10, 10],
  ])('con máximo 10, %i pasa a %i', (current, expected) => {
    expect(regenPower(power('hero-a', current, 10))).toEqual(power('hero-a', expected, 10))
  })

  it.each([
    [6, 8, 8],
    [7, 8, 8],
    [8, 8, 8],
    [10, 12, 12],
    [11, 12, 12],
  ])('el tope es el máximo de cada héroe: %i con máximo %i pasa a %i', (current, max, expected) => {
    expect(regenPower(power('hero-a', current, max))).toEqual(power('hero-a', expected, max))
  })

  it('a un paso del máximo produce el máximo y nunca máximo + 1', () => {
    const result = regenPower(power('hero-a', 9, 10))

    expect(result.current).toBe(10)
    expect(result.current).toBeLessThanOrEqual(result.max)
  })
})

describe('HU-11 — restauración total al finalizar el combate', () => {
  it.each([0, 1, 2, 5, 9, 10])(
    'con %i de Poder el fin de combate deja el máximo (10)',
    (current) => {
      expect(restorePower(power('hero-a', current, 10))).toEqual(power('hero-a', 10, 10))
    },
  )

  it.each([0, 3, 7, 8])('el máximo es el de cada héroe: con %i y máximo 8 deja 8', (current) => {
    expect(restorePower(power('hero-b', current, 8))).toEqual(power('hero-b', 8, 8))
  })
})

describe('HU-11 — reanimación: todo el Poder disponible (ALL_AVAILABLE)', () => {
  it.each([
    [10, 10],
    [7, 7],
    [1, 1],
  ])('con %i de Poder consume los %i y deja 0', (current, spent) => {
    expect(spendPower(power('medico', current), ALL)).toEqual({
      ok: true,
      spent,
      state: power('medico', 0),
    })
  })

  it('con 0 de Poder no hay nada que consumir: no se ejecuta gratis y se fuerza el básico', () => {
    const before = power('medico', 0)

    expect(canAfford(before, ALL)).toBe(false)
    expect(spendPower(before, ALL)).toEqual({
      ok: false,
      reason: 'insufficient',
      fallbackAction: 'basic_attack',
      spent: 0,
      state: before,
    })
  })
})

describe('HU-11 — consulta previa canAfford: no consume y coincide con spendPower', () => {
  it.each([
    [4, fixed(4), true],
    [3, fixed(4), false],
    [0, NONE, true],
    [1, ALL, true],
    [0, ALL, false],
  ])('con %i de Poder y costo %j la respuesta es %s', (current, cost, expected) => {
    expect(canAfford(power('hero-a', current), cost)).toBe(expected)
  })

  it('no modifica el estado que recibe', () => {
    const before = Object.freeze(power('hero-a', 6))

    expect(canAfford(before, fixed(6))).toBe(true)
    expect(before).toEqual(power('hero-a', 6))
  })

  it('nunca discrepa de spendPower en ninguna combinación de saldo y costo', () => {
    const costs: readonly HeroPowerCost[] = [
      NONE,
      ALL,
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(fixed),
    ]
    const discrepancies: string[] = []

    for (let current = 0; current <= 10; current += 1) {
      for (const cost of costs) {
        const state = power('hero-a', current)
        if (canAfford(state, cost) !== spendPower(state, cost).ok) {
          discrepancies.push(`${String(current)} / ${JSON.stringify(cost)}`)
        }
      }
    }

    expect(discrepancies).toEqual([])
  })
})

describe('HU-11 — el nuevo valor se usa de inmediato para validar la siguiente acción', () => {
  it('con 10, tras gastar 4 quedan 6 y un costo 7 se rechaza contra 6, no contra 10', () => {
    const before = power('hero-a', 10)
    const first = spendPower(before, fixed(4))

    expect(first).toMatchObject({ ok: true, state: power('hero-a', 6) })
    expect(spendPower(first.state, fixed(7))).toMatchObject({
      ok: false,
      reason: 'insufficient',
      fallbackAction: 'basic_attack',
      state: power('hero-a', 6),
    })
    // Control: contra el saldo viejo (10) ese mismo costo SÍ se pagaría.
    expect(spendPower(before, fixed(7)).ok).toBe(true)
  })

  it('tras regenerar, el saldo recuperado habilita de inmediato un costo que antes no cubría', () => {
    const before = power('hero-a', 6)
    const regenerated = regenPower(before)

    expect(canAfford(before, fixed(8))).toBe(false)
    expect(canAfford(regenerated, fixed(8))).toBe(true)
  })
})

describe('HU-11 — secuencia completa de un combate', () => {
  it('10 → -4 → +2 → -8 → +2 → fin de combate', () => {
    const start = createHeroPower('hero-a', 10)
    expect(getPower(start)).toBe(10)

    const afterSkill = spendPower(start, fixed(4))
    expect(afterSkill.state.current).toBe(6)

    const afterTurn = regenPower(afterSkill.state)
    expect(afterTurn.current).toBe(8)

    const afterBigSkill = spendPower(afterTurn, fixed(8))
    expect(afterBigSkill).toMatchObject({ ok: true, spent: 8 })
    expect(afterBigSkill.state.current).toBe(0)

    const afterSecondTurn = regenPower(afterBigSkill.state)
    expect(afterSecondTurn.current).toBe(2)

    const afterCombat = restorePower(afterSecondTurn)
    expect(afterCombat).toEqual(power('hero-a', 10, 10))
  })

  it('sin Poder, una habilidad de costo 2 solo se paga tras el siguiente turno', () => {
    const drained = power('hero-a', 0)

    expect(spendPower(drained, fixed(2)).ok).toBe(false)
    expect(spendPower(regenPower(drained), fixed(2))).toMatchObject({ ok: true, spent: 2 })
  })
})

describe('HU-11 — el Poder nunca sale de 0 ≤ actual ≤ máximo', () => {
  /** Generador determinista (LCG): la misma semilla repite la misma secuencia. */
  const lcg = (seed: number): (() => number) => {
    let state = seed >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 2 ** 32
    }
  }

  const pickExecution = (random: () => number): PowerActionExecution => {
    const roll = random()
    if (roll < 0.6) return 'EXECUTED'
    return roll < 0.8 ? 'CANCELLED' : 'INVALID'
  }

  const pickCost = (random: () => number): HeroPowerCost => {
    const roll = random()
    if (roll < 0.15) return NONE
    if (roll < 0.3) return ALL
    return fixed(1 + Math.floor(random() * 14))
  }

  it.each([0, 1, 8, 10, 12])(
    'tras miles de operaciones mezcladas con máximo %i respeta el rango y las reglas de cada operación',
    (max) => {
      const random = lcg(20260920 + max)
      const violations: string[] = []
      let state = createHeroPower('hero-a', max)

      for (let step = 0; step < 3000; step += 1) {
        const before = state
        const roll = random()
        let label: string

        if (roll < 0.2) {
          label = 'regen'
          state = regenPower(before)
          if (state.current !== Math.min(before.max, before.current + POWER_REGEN_PER_TURN)) {
            violations.push(`${label}: ${JSON.stringify({ before, state })}`)
          }
        } else if (roll < 0.28) {
          label = 'restore'
          state = restorePower(before)
          if (state.current !== before.max)
            violations.push(`${label}: ${JSON.stringify({ before, state })}`)
        } else {
          const cost = pickCost(random)
          const execution = pickExecution(random)
          label = `spend ${JSON.stringify(cost)} ${execution}`
          const result = spendPower(before, cost, execution)
          state = result.state
          // Se ensancha el tipo: en la rama `ok: false` el compilador ya sabe que es 0,
          // pero la prueba debe comprobarlo en tiempo de ejecución.
          const spent: number = result.spent

          const chargedCorrectly = result.ok
            ? state.current === before.current - spent && spent >= 0
            : state.current === before.current && spent === 0
          const coherentWithQuery =
            execution !== 'EXECUTED' ? !result.ok : result.ok === canAfford(before, cost)

          if (!chargedCorrectly || !coherentWithQuery) {
            violations.push(`${label}: ${JSON.stringify({ before, result })}`)
          }
        }

        if (state.current < 0 || state.current > state.max || state.heroId !== 'hero-a') {
          violations.push(`${label} fuera de invariante: ${JSON.stringify({ before, state })}`)
        }
        if (state.max !== max)
          violations.push(`${label} cambió el máximo: ${JSON.stringify(state)}`)
      }

      expect(violations).toEqual([])
    },
  )
})

describe('HU-11 — aislamiento: el Poder es del héroe, no del jugador', () => {
  interface PowerBook {
    spend(heroId: string, amount: number): void
    read(heroId: string): number
  }

  /** Consumidor de referencia: conserva UN estado por héroe y delega en la política. */
  const perHeroBook = (initial: readonly HeroPowerState[]): PowerBook => {
    const states = new Map(initial.map((state) => [state.heroId, state]))
    const stateOf = (heroId: string): HeroPowerState => {
      const state = states.get(heroId)
      if (state === undefined) throw new Error(`Sin Poder registrado para ${heroId}.`)
      return state
    }

    return {
      spend: (heroId, amount) => {
        states.set(heroId, spendPower(stateOf(heroId), fixed(amount)).state)
      },
      read: (heroId) => getPower(stateOf(heroId)),
    }
  }

  /** Modelo EQUIVOCADO que esta HU prohíbe: un único saldo compartido por jugador. */
  const perPlayerBook = (start: number): PowerBook => {
    let pool = start
    return {
      spend: (heroId, amount) => {
        void heroId
        pool -= amount
      },
      read: (heroId) => {
        void heroId
        return pool
      },
    }
  }

  /** Héroe A (10/10) y héroe B (8/8): gastar 4 en A deja A en 6 y B en 8. */
  const keepsHeroesIsolated = (book: PowerBook): boolean => {
    book.spend('hero-a', 4)
    return book.read('hero-a') === 6 && book.read('hero-b') === 8
  }

  it('gastar 4 de Poder en el héroe A deja A en 6/10 y el héroe B del mismo jugador en 8/8', () => {
    const book = perHeroBook([power('hero-a', 10, 10), power('hero-b', 8, 8)])

    expect(keepsHeroesIsolated(book)).toBe(true)
  })

  it('control: la comprobación detecta un modelo con saldo único por jugador', () => {
    expect(keepsHeroesIsolated(perPlayerBook(10))).toBe(false)
  })

  it('consumir, regenerar y restaurar en A no altera a B', () => {
    const heroA = Object.freeze(power('hero-a', 10, 10))
    const heroB = Object.freeze(power('hero-b', 8, 8))

    const spentA = spendPower(heroA, fixed(4)).state
    const regenA = regenPower(spentA)
    const restoredA = restorePower(regenA)

    expect([spentA.current, regenA.current, restoredA.current]).toEqual([6, 8, 10])
    expect(heroB).toEqual(power('hero-b', 8, 8))
    expect(heroA).toEqual(power('hero-a', 10, 10))
  })

  it('dos héroes con el mismo saldo numérico no comparten identidad ni objeto', () => {
    const heroA = power('hero-a', 8, 8)
    const heroB = power('hero-b', 8, 8)

    const result = spendPower(heroA, fixed(3)).state

    expect(result.heroId).toBe('hero-a')
    expect(result).not.toBe(heroA)
    expect(heroB).toEqual(power('hero-b', 8, 8))
  })

  it('no hay estado de módulo: operar con otros héroes no cambia el resultado de A', () => {
    const heroA = power('hero-a', 10, 10)
    const heroB = power('hero-b', 8, 8)
    const first = spendPower(heroA, fixed(4))

    spendPower(heroB, fixed(8))
    regenPower(heroB)
    restorePower(heroB)

    expect(spendPower(heroA, fixed(4))).toEqual(first)
  })
})

describe('HU-11 — validación de estados y costos recibidos de fuera del dominio', () => {
  it.each([
    ['heroId ausente', { current: 1, max: 2 }],
    ['heroId que no es texto', { heroId: 7, current: 1, max: 2 }],
    ['actual no finito', { heroId: 'hero-a', current: Number.NaN, max: 2 }],
    ['máximo infinito', { heroId: 'hero-a', current: 1, max: Number.POSITIVE_INFINITY }],
    ['actual como texto', { heroId: 'hero-a', current: '1', max: 2 }],
  ])('rechaza un estado con %s en todas las operaciones', (_case, raw) => {
    const state = raw as unknown as HeroPowerState

    expect(() => getPower(state)).toThrow(DomainError)
    expect(() => getMaxPower(state)).toThrow(DomainError)
    expect(() => canAfford(state, NONE)).toThrow(DomainError)
    expect(() => spendPower(state, NONE)).toThrow(DomainError)
    expect(() => regenPower(state)).toThrow(DomainError)
    expect(() => restorePower(state)).toThrow(DomainError)
  })

  it.each([
    ['máximo negativo', 'hero-a', -1],
    ['máximo decimal', 'hero-a', 1.5],
    ['máximo NaN', 'hero-a', Number.NaN],
    ['héroe vacío', ' ', 10],
  ])('createHeroPower rechaza %s', (_case, heroId, max) => {
    expect(() => createHeroPower(heroId, max)).toThrow(DomainError)
  })

  it('canAfford rechaza un costo mal formado en vez de responder que sí', () => {
    expect(() => canAfford(power('hero-a', 5), fixed(0))).toThrow(DomainError)
    expect(() => canAfford(power('hero-a', 5), { mode: 'X' } as unknown as HeroPowerCost)).toThrow(
      DomainError,
    )
  })
})
