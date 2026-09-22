import type {
  EquippedHero,
  EquippedHeroEffect,
  EquippedHeroStats,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import {
  EquipmentEffectOutcome,
  PendingReason,
} from '../../src/application/use-cases/BuildHeroEffectTable'
import { prepareAttack } from '../../src/application/use-cases/PrepareAttack'
import { DomainError } from '../../src/domain/errors/DomainError'
import { AttackNotDefinedError } from '../../src/domain/errors/AttackResolutionErrors'
import { InsufficientNoDamageProbabilityError } from '../../src/domain/errors/RandomEffectErrors'
import { RandomEffectType } from '../../src/domain/random-effects/RandomEffectType'
import { HeroSubtype } from '../../src/domain/value-objects/HeroSubtype'
import {
  attackBonusEffect,
  conditionalDefenseEffect,
  criticalChancePercentageEffect,
  equippedHeroFixture,
  opponentDamageDiceEffect,
} from '../fixtures/equipped-hero'

/**
 * HU-20, CA-02 y CA-03: el Ataque incluye los bonos aplicables y la Defensa es
 * la del heroe objetivo con sus modificadores vigentes.
 */
const C = RandomEffectType.CriticalDamage
const N = RandomEffectType.NoDamage

const stats = (attack: number | null, defense: number): EquippedHeroStats => ({
  power: 8,
  health: 40,
  defense,
  attack,
  damage: { mode: 'DICE', count: 1, sides: 4 },
  healing: null,
})

const opponentCriticalDecrease = (basisPoints = 200): EquippedHeroEffect => ({
  sourceProductId: 'a1b2c3d4-0000-4000-8000-000000000001',
  sourceProductReference: 'baculo-de-permafrost',
  kind: 'STAT_MODIFIER',
  target: 'OPPONENT',
  statistic: 'CRITICAL_CHANCE',
  operation: 'DECREASE',
  magnitude: { mode: 'PERCENTAGE', basisPoints },
  hasActivationCondition: false,
  appliedToStats: false,
})

const opponentAttackDecrease = (amount = 1): EquippedHeroEffect => ({
  sourceProductId: 'a1b2c3d4-0000-4000-8000-000000000002',
  sourceProductReference: 'vision-borrosa',
  kind: 'STAT_MODIFIER',
  target: 'OPPONENT',
  statistic: 'ATTACK',
  operation: 'DECREASE',
  magnitude: { mode: 'FIXED', amount },
  hasActivationCondition: false,
  appliedToStats: false,
})

/** Heroe SIN equipo: sus estadisticas efectivas son las base. */
const bare = (
  subtype: string,
  attack: number | null,
  defense: number,
  activeEffects: readonly EquippedHeroEffect[] = [],
): EquippedHero =>
  equippedHeroFixture({
    subtype,
    baseStats: stats(attack, defense),
    effectiveStats: stats(attack, defense),
    activeEffects,
  })

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }

  return value
}

describe('prepareAttack — CA-02: el Ataque incluye los bonos del equipo', () => {
  it('usa el Ataque EFECTIVO (10 base + 3 de la espada = 13), no el base', () => {
    const attacker = equippedHeroFixture() // base 10, efectivo 13, con attackBonusEffect ya aplicado
    const target = bare('GUERRERO_TANQUE', 10, 11)

    const { attack } = prepareAttack(attacker, target)

    expect(attacker.baseStats.attack).toBe(10)
    expect(attack.base).toBe(13)
  })

  it('NO vuelve a sumar el efecto ya consolidado (appliedToStats): 13, no 16', () => {
    const attacker = equippedHeroFixture()

    expect(attackBonusEffect.appliedToStats).toBe(true)
    expect(attackBonusEffect.magnitude).toEqual({ mode: 'FIXED', amount: 3 })
    expect(prepareAttack(attacker, bare('GUERRERO_TANQUE', 10, 11)).attack.base).not.toBe(16)
    expect(prepareAttack(attacker, bare('GUERRERO_TANQUE', 10, 11)).attack.base).toBe(13)
  })

  it('los efectos que no son del Ataque (defensa condicionada, dano) no lo alteran', () => {
    const attacker = equippedHeroFixture({
      activeEffects: [conditionalDefenseEffect, opponentDamageDiceEffect],
      effectiveStats: stats(10, 8),
    })

    expect(prepareAttack(attacker, bare('GUERRERO_TANQUE', 10, 11)).attack.base).toBe(10)
  })

  it('un heroe sin equipo ataca con su Ataque base', () => {
    expect(
      prepareAttack(bare('MAGO_FUEGO', 10, 10), bare('GUERRERO_ARMAS', 10, 11)).attack.base,
    ).toBe(10)
  })
})

describe('prepareAttack — CA-03: la Defensa es la del objetivo con sus modificadores', () => {
  it('usa la Defensa EFECTIVA del objetivo (11 base + 2 de armadura = 13)', () => {
    const target = equippedHeroFixture({
      subtype: 'GUERRERO_TANQUE',
      baseStats: stats(10, 11),
      effectiveStats: stats(10, 13),
      activeEffects: [],
    })

    expect(prepareAttack(bare('GUERRERO_ARMAS', 10, 11), target).defenseValue).toBe(13)
  })

  it('la Defensa es la del OBJETIVO, no la del atacante', () => {
    const { defenseValue } = prepareAttack(
      bare('GUERRERO_ARMAS', 10, 99),
      bare('MAGO_HIELO', 10, 10),
    )

    expect(defenseValue).toBe(10)
  })

  it('una Defensa de 0 llega tal cual', () => {
    expect(
      prepareAttack(bare('GUERRERO_ARMAS', 10, 11), bare('MAGO_HIELO', 10, 0)).defenseValue,
    ).toBe(0)
  })
})

describe('prepareAttack — dado de Ataque por subtipo (Tabla 6)', () => {
  it.each([
    ['GUERRERO_TANQUE', 6],
    ['GUERRERO_ARMAS', 6],
    ['MAGO_FUEGO', 8],
    ['MAGO_HIELO', 8],
    ['PICARO_VENENO', 10],
    ['PICARO_MACHETE', 10],
  ])('%s ataca con 10 + 1d%i', (subtype, sides) => {
    const { attack } = prepareAttack(bare(subtype, 10, 5), bare('GUERRERO_TANQUE', 10, 11))

    expect(attack.dice).toEqual({ count: 1, sides })
  })
})

describe('prepareAttack — la tabla del atacante', () => {
  it('es su tabla base con sus propios incrementos de critico (+3 %: 400 -> 640 filas)', () => {
    const { table } = prepareAttack(equippedHeroFixture(), bare('GUERRERO_TANQUE', 10, 11))

    expect(table.rowsOf(C)).toBe(640)
    expect(table.rowsOf(N)).toBe(2400 - 240)
  })

  it('un atacante sin equipo usa la tabla base de su subtipo', () => {
    const { table } = prepareAttack(bare('GUERRERO_ARMAS', 10, 8), bare('GUERRERO_TANQUE', 10, 11))

    expect(table.rowsOf(C)).toBe(400)
  })

  it('el equipo del atacante se clasifica y queda en attackerEffects', () => {
    const { attackerEffects } = prepareAttack(
      equippedHeroFixture(),
      bare('GUERRERO_TANQUE', 10, 11),
    )

    expect(attackerEffects.appliedEffects).toHaveLength(1)
    expect(attackerEffects.reflectedInStatsEffects).toHaveLength(1)
    expect(attackerEffects.pendingEffects).toHaveLength(0)
    expect(attackerEffects.subtype).toBe(HeroSubtype.GuerreroArmas)
  })
})

describe('prepareAttack — lo que el equipo del OBJETIVO le quita al atacante', () => {
  const attacker = (): EquippedHero => bare('GUERRERO_ARMAS', 10, 11)

  it('«-1 al ataque del oponente» (Vision borrosa): el Ataque del atacante baja 1', () => {
    const { attack } = prepareAttack(
      attacker(),
      bare('PICARO_VENENO', 10, 8, [opponentAttackDecrease(1)]),
    )

    expect(attack.base).toBe(9)
  })

  it('«-2 % de critico al ataque del oponente» (Baculo de Permafrost): el critico del atacante baja 160 filas', () => {
    const { table } = prepareAttack(
      attacker(),
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200)]),
    )

    expect(table.rowsOf(C)).toBe(400 - 160)
    expect(table.rowsOf(N)).toBe(2400 + 160)
  })

  it('la resta de critico aplica sobre el neto del atacante (+3 % propio, -2 % del objetivo = +1 %)', () => {
    const { table } = prepareAttack(
      equippedHeroFixture(),
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200)]),
    )

    expect(table.rowsOf(C)).toBe(400 + 240 - 160)
  })

  it('varias restas al Ataque se suman', () => {
    const { attack } = prepareAttack(
      attacker(),
      bare('PICARO_VENENO', 10, 8, [opponentAttackDecrease(1), opponentAttackDecrease(2)]),
    )

    expect(attack.base).toBe(7)
  })

  it('el Ataque no baja de 0 (igual que Player-Inventory acota las estadisticas)', () => {
    const { attack } = prepareAttack(
      bare('GUERRERO_ARMAS', 2, 11),
      bare('PICARO_VENENO', 10, 8, [opponentAttackDecrease(5)]),
    )

    expect(attack.base).toBe(0)
  })

  it('el critico no baja de 0 filas: un Tanque (0 % de critico) contra un Baculo no queda negativo', () => {
    const { table } = prepareAttack(
      bare('GUERRERO_TANQUE', 10, 11),
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200)]),
    )

    expect(table.rowsOf(C)).toBe(0)
    expect(table.rowsOf(N)).toBe(4000)
  })

  it('el Baculo y la Vision borrosa juntos alteran a la vez el Ataque y la tabla', () => {
    const { attack, table } = prepareAttack(
      attacker(),
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200), opponentAttackDecrease(1)]),
    )

    expect(attack.base).toBe(9)
    expect(table.rowsOf(C)).toBe(240)
  })

  it('los efectos aplicados quedan clasificados como AFFECTS_ATTACKERS en targetEffects', () => {
    const { targetEffects } = prepareAttack(
      attacker(),
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200), opponentAttackDecrease(1)]),
    )

    expect(targetEffects.map(({ outcome }) => outcome)).toEqual([
      EquipmentEffectOutcome.AffectsAttackers,
      EquipmentEffectOutcome.AffectsAttackers,
    ])
  })

  it('los efectos PROPIOS del objetivo no se le aplican al atacante (su critico +3 % es para sus golpes)', () => {
    const own = { ...criticalChancePercentageEffect }
    const { table, attack } = prepareAttack(attacker(), bare('MAGO_HIELO', 10, 10, [own]))

    expect(table.rowsOf(C)).toBe(400)
    expect(attack.base).toBe(10)
  })

  it('los efectos dirigidos al oponente del ATACANTE no se aplican a si mismo (afectan a quien lo ataque)', () => {
    const { table, attack, attackerEffects } = prepareAttack(
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200), opponentAttackDecrease(1)]),
      bare('GUERRERO_ARMAS', 10, 11),
    )

    expect(attack.base).toBe(10)
    expect(table.rowsOf(C)).toBe(480)
    expect(attackerEffects.opponentEffects).toHaveLength(2)
  })

  describe('variantes que el documento no define: pendientes y NO aplicadas', () => {
    it.each<[string, EquippedHeroEffect]>([
      [
        '«-2 % de Ataque» como porcentaje',
        {
          ...opponentAttackDecrease(),
          magnitude: { mode: 'PERCENTAGE', basisPoints: 200 },
        },
      ],
      [
        'un aumento del Ataque del oponente',
        { ...opponentAttackDecrease(), operation: 'INCREASE' },
      ],
      ['una resta de Defensa', { ...opponentAttackDecrease(), statistic: 'DEFENSE' }],
      ['un critico con condicion', { ...opponentCriticalDecrease(), hasActivationCondition: true }],
      ['un ataque temporal', { ...opponentAttackDecrease(), durationTurns: 2 }],
    ])('%s', (_label, effect) => {
      const { attack, table, targetEffects } = prepareAttack(
        attacker(),
        bare('MAGO_HIELO', 10, 10, [effect]),
      )

      expect(attack.base).toBe(10)
      expect(table.rowsOf(C)).toBe(400)
      expect(targetEffects[0]?.outcome).toBe(EquipmentEffectOutcome.PendingDefinition)
      expect(targetEffects[0]?.reasons.length).toBeGreaterThan(0)
    })

    it('el motivo de un efecto condicionado se conserva para quien lo audite', () => {
      const { targetEffects } = prepareAttack(
        attacker(),
        bare('MAGO_HIELO', 10, 10, [
          { ...opponentCriticalDecrease(), hasActivationCondition: true },
        ]),
      )

      expect(targetEffects[0]?.reasons).toEqual([PendingReason.ActivationConditionUnevaluated])
    })
  })
})

describe('prepareAttack — falla de forma explicita, sin inventar', () => {
  it.each(['CHAMAN', 'MEDICO'])(
    '%s no tiene Ataque (Tabla 6: «-»): AttackNotDefinedError, no un Ataque de 0',
    (subtype) => {
      expect(() => prepareAttack(bare(subtype, null, 4), bare('GUERRERO_TANQUE', 10, 11))).toThrow(
        AttackNotDefinedError,
      )
      expect(() => prepareAttack(bare(subtype, null, 4), bare('GUERRERO_TANQUE', 10, 11))).toThrow(
        new RegExp(`"${subtype}"`),
      )
    },
  )

  it('un heroe ofensivo con Ataque null (Catalog lo declaro como dado) tambien falla: dato mal cargado', () => {
    expect(() =>
      prepareAttack(bare('GUERRERO_ARMAS', null, 11), bare('GUERRERO_TANQUE', 10, 11)),
    ).toThrow(AttackNotDefinedError)
  })

  it('AttackNotDefinedError es un DomainError', () => {
    expect(new AttackNotDefinedError('CHAMAN')).toBeInstanceOf(DomainError)
    expect(new AttackNotDefinedError('CHAMAN').name).toBe('AttackNotDefinedError')
  })

  it.each(['GUERRERO', 'guerrero_armas', 'HEROE_NUEVO', ''])(
    'un subtipo (%p) fuera de hero-subtypes-v1 lanza DomainError, sin adivinar',
    (subtype) => {
      expect(() => prepareAttack(bare(subtype, 10, 11), bare('GUERRERO_TANQUE', 10, 11))).toThrow(
        DomainError,
      )
    },
  )

  it('un critico propio que supera el «no causar dano» disponible falla (no se recorta)', () => {
    const huge: EquippedHeroEffect = {
      ...criticalChancePercentageEffect,
      magnitude: { mode: 'PERCENTAGE', basisPoints: 5000 },
    }

    expect(() =>
      prepareAttack(bare('GUERRERO_ARMAS', 10, 11, [huge]), bare('GUERRERO_TANQUE', 10, 11)),
    ).toThrow(InsufficientNoDamageProbabilityError)
  })

  it('el subtipo del OBJETIVO no se valida: para recibir un golpe no hace falta su tabla', () => {
    expect(() =>
      prepareAttack(bare('GUERRERO_ARMAS', 10, 11), bare('HEROE_NUEVO', 10, 11)),
    ).not.toThrow()
  })

  it('un objetivo sanador (Chaman) puede ser atacado: solo se usa su Defensa', () => {
    const { defenseValue } = prepareAttack(bare('GUERRERO_ARMAS', 10, 11), bare('CHAMAN', null, 4))

    expect(defenseValue).toBe(4)
  })
})

describe('prepareAttack — pura y sin efectos laterales', () => {
  it('no muta a los heroes ni a sus efectos (entradas congeladas)', () => {
    const attacker = deepFreeze(equippedHeroFixture())
    const target = deepFreeze(
      bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200), opponentAttackDecrease(1)]),
    )

    expect(() => prepareAttack(attacker, target)).not.toThrow()
  })

  it('es determinista: las mismas entradas dan la misma preparacion', () => {
    const attacker = equippedHeroFixture()
    const target = bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200)])

    const one = prepareAttack(attacker, target)
    const other = prepareAttack(attacker, target)

    expect(other.attack).toEqual(one.attack)
    expect(other.defenseValue).toBe(one.defenseValue)
    expect(other.table.ranges).toEqual(one.table.ranges)
  })

  it('no toca la aleatoriedad: no llama a Math.random', () => {
    const spy = jest.spyOn(Math, 'random')

    prepareAttack(equippedHeroFixture(), bare('GUERRERO_TANQUE', 10, 11))

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('la tabla del atacante NO se altera al preparar contra distintos objetivos', () => {
    const attacker = equippedHeroFixture()
    const staff = bare('MAGO_HIELO', 10, 10, [opponentCriticalDecrease(200)])
    const plain = bare('GUERRERO_TANQUE', 10, 11)

    const againstStaff = prepareAttack(attacker, staff)
    const againstPlain = prepareAttack(attacker, plain)

    expect(againstStaff.table.rowsOf(C)).toBe(480)
    expect(againstPlain.table.rowsOf(C)).toBe(640)
    expect(againstStaff.attackerEffects.table.rowsOf(C)).toBe(640)
  })
})
