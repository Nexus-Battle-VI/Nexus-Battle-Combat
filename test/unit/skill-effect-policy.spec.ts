import type { CombatAbility, CombatAbilityEffect } from '../../src/domain/entities/CombatProfile'
import { evaluateSkill } from '../../src/domain/policies/SkillEffectPolicy'
import {
  EMBATE,
  LOTUS,
  REANIMATE,
  SHIELD_STRIKE,
  STONE_HAND,
  STORM,
  attackBonus,
  damageBonus,
  dice,
  fixed,
} from '../fixtures/skills'

/**
 * Que efectos de una habilidad sabe ejecutar Combat (HU-19, contrato `hu-19-skills-v1` §10.2).
 * Solo el patron «+N (o +NdM) al Ataque / al Dano» propio, sin duracion ni condicion; todo lo
 * demas se rechaza de forma explicita.
 */
const abilityWith = (effects: readonly CombatAbilityEffect[]): CombatAbility => ({
  ...SHIELD_STRIKE,
  effects,
})

/** Este describe solo cubre el patron DAMAGE (bono de Ataque/Dano); Reanimacion tiene el suyo propio abajo. */
const supported = (ability: CombatAbility) => {
  const result = evaluateSkill(ability)

  if (!result.supported) {
    throw new Error(`se esperaba una habilidad soportada: ${result.reason}`)
  }

  if (result.kind !== 'DAMAGE') {
    throw new Error(`se esperaba el patron DAMAGE, no ${result.kind}`)
  }

  return result
}

describe('evaluateSkill — habilidades soportadas', () => {
  it('Golpe con escudo: +2 al Ataque, sin bono de Dano', () => {
    expect(supported(SHIELD_STRIKE)).toEqual({
      supported: true,
      kind: 'DAMAGE',
      attackBonus: { fixed: 2, dice: [] },
      damageBonus: { fixed: 0, dice: [] },
    })
  })

  it('Embate sangriento: +2 al Ataque y +1 al Dano', () => {
    expect(supported(EMBATE)).toMatchObject({
      attackBonus: { fixed: 2, dice: [] },
      damageBonus: { fixed: 1, dice: [] },
    })
  })

  it('Golpe de tormenta: +(3d6) al Ataque en dados y +2 fijo al Dano', () => {
    expect(supported(STORM)).toMatchObject({
      attackBonus: { fixed: 0, dice: [{ count: 3, sides: 6 }] },
      damageBonus: { fixed: 2, dice: [] },
    })
  })

  it('Flor de loto: +(4d8) al Dano y nada al Ataque', () => {
    expect(supported(LOTUS)).toMatchObject({
      attackBonus: { fixed: 0, dice: [] },
      damageBonus: { fixed: 0, dice: [{ count: 4, sides: 8 }] },
    })
  })

  it('los bonos se AGREGAN por estadistica: fijos suman y los dados conservan el orden de los efectos', () => {
    const result = supported(
      abilityWith([
        attackBonus(fixed(1)),
        attackBonus(dice(2, 8)),
        damageBonus(dice(1, 4)),
        attackBonus(fixed(2)),
        damageBonus(dice(3, 6)),
        damageBonus(fixed(5)),
      ]),
    )

    expect(result.attackBonus).toEqual({ fixed: 3, dice: [{ count: 2, sides: 8 }] })
    expect(result.damageBonus).toEqual({
      fixed: 5,
      dice: [
        { count: 1, sides: 4 },
        { count: 3, sides: 6 },
      ],
    })
  })
})

describe('evaluateSkill — lo que NO se soporta se rechaza de forma explicita', () => {
  const effect = (change: Partial<CombatAbilityEffect>): CombatAbilityEffect => ({
    ...attackBonus(fixed(2)),
    ...change,
  })

  it.each([
    ['un efecto DAMAGE directo sobre el oponente', effect({ kind: 'DAMAGE', target: 'OPPONENT' })],
    ['una sanacion (HEALING)', effect({ kind: 'HEALING', target: 'ALLIED_GROUP' })],
    ['una inmunidad', effect({ kind: 'IMMUNITY' })],
    [
      'un reflejo de dano',
      effect({ kind: 'REFLECT_DAMAGE', magnitude: { mode: 'PERCENTAGE', basisPoints: 5000 } }),
    ],
    ['una reanimacion', effect({ kind: 'REVIVE', target: 'ALLY' })],
    ['un estado temporal', effect({ kind: 'TEMPORARY_STATUS', durationTurns: 2 })],
    ['un efecto sobre el oponente', effect({ target: 'OPPONENT' })],
    ['un efecto sobre un aliado', effect({ target: 'ALLY' })],
    ['un efecto sobre un grupo aliado', effect({ target: 'ALLIED_GROUP' })],
    ['una reduccion (DECREASE)', effect({ operation: 'DECREASE' })],
    ['un producto (MULTIPLY)', effect({ operation: 'MULTIPLY' })],
    ['un valor fijado (SET)', effect({ operation: 'SET' })],
    ['la Defensa', effect({ statistic: 'DEFENSE' })],
    ['la Sanacion', effect({ statistic: 'HEALING' })],
    ['el Poder', effect({ statistic: 'POWER' })],
    ['la Vida', effect({ statistic: 'HEALTH' })],
    ['el critico', effect({ statistic: 'CRITICAL_CHANCE' })],
    ['un efecto sin estadistica', effect({ statistic: undefined })],
    ['una duracion de un turno', effect({ durationTurns: 1 })],
    ['una duracion de dos turnos', effect({ durationTurns: 2 })],
    ['una condicion de activacion', effect({ hasActivationCondition: true })],
    ['una magnitud en porcentaje', effect({ magnitude: { mode: 'PERCENTAGE', basisPoints: 500 } })],
    ['un efecto sin magnitud', effect({ magnitude: undefined })],
    ['un FIXED de 0', effect({ magnitude: fixed(0) })],
    ['un FIXED decimal', effect({ magnitude: fixed(1.5) })],
    ['unos dados de 0 lanzamientos', effect({ magnitude: dice(0, 6) })],
    ['unos dados de una cara', effect({ magnitude: dice(2, 1) })],
    ['unos dados con caras decimales', effect({ magnitude: dice(2, 6.5) })],
  ])('%s no esta soportado', (_label, unsupportedEffect) => {
    const result = evaluateSkill(abilityWith([unsupportedEffect]))

    expect(result.supported).toBe(false)
    expect(result).toMatchObject({ reason: expect.any(String) })
  })

  it('UN efecto no soportado invalida TODA la habilidad: no se aplica a medias', () => {
    const result = evaluateSkill(
      abilityWith([attackBonus(fixed(2)), damageBonus(fixed(1)), effect({ durationTurns: 2 })]),
    )

    expect(result.supported).toBe(false)
  })

  it('una habilidad sin efectos no esta soportada (no se inventa uno)', () => {
    expect(evaluateSkill(abilityWith([])).supported).toBe(false)
  })

  it('Mano de piedra (duracion y condicion) no esta soportada', () => {
    expect(evaluateSkill(STONE_HAND).supported).toBe(false)
  })

  it('el motivo se explica en el resultado (para el registro, nunca para el cliente)', () => {
    const result = evaluateSkill(abilityWith([effect({ durationTurns: 2 })]))

    expect(result).toEqual({
      supported: false,
      reason: 'un efecto con duracion exige un estado de batalla mas alla del turno.',
    })
  })
})

/**
 * Excepcion de curacion de HU-12 (Tabla 7, sin Task de Management): Reanimacion
 * (Medico) es la UNICA habilidad de curacion formalmente soportada.
 */
describe('evaluateSkill — Reanimacion (excepcion de curacion, HU-12)', () => {
  it('Reanimacion SI esta soportada: kind HEAL con la magnitud del efecto REVIVE', () => {
    expect(evaluateSkill(REANIMATE)).toEqual({
      supported: true,
      kind: 'HEAL',
      healMagnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
    })
  })

  const revive = (change: Partial<CombatAbilityEffect>): CombatAbilityEffect => ({
    kind: 'REVIVE',
    target: 'ALLY',
    magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
    hasActivationCondition: false,
    ...change,
  })

  it.each([
    ['sobre un rival', revive({ target: 'OPPONENT' })],
    ['sobre todo el grupo aliado (Canto del Bosque)', revive({ target: 'ALLIED_GROUP' })],
    ['con duracion (Vinculo Natural)', revive({ durationTurns: 2 })],
    ['con condicion de activacion', revive({ hasActivationCondition: true })],
    ['con magnitud FIXED en vez de PERCENTAGE', revive({ magnitude: fixed(100) })],
    ['con magnitud en DADOS', revive({ magnitude: dice(2, 6) })],
    ['con 0 puntos base', revive({ magnitude: { mode: 'PERCENTAGE', basisPoints: 0 } })],
    [
      'con mas de 10000 puntos base',
      revive({ magnitude: { mode: 'PERCENTAGE', basisPoints: 10_001 } }),
    ],
    ['sin magnitud', revive({ magnitude: undefined })],
  ])('una curacion %s no esta soportada', (_label, unsupportedEffect) => {
    const result = evaluateSkill(abilityWith([unsupportedEffect]))

    expect(result.supported).toBe(false)
  })

  it('un REVIVE junto a otro efecto (aunque sea un segundo REVIVE) no esta soportado: solo uno', () => {
    const result = evaluateSkill(abilityWith([revive({}), revive({})]))

    expect(result.supported).toBe(false)
  })

  it('un REVIVE mezclado con un STAT_MODIFIER no esta soportado', () => {
    const result = evaluateSkill(abilityWith([revive({}), attackBonus(fixed(1))]))

    expect(result.supported).toBe(false)
  })
})

/**
 * Las 24 habilidades del Catalog desplegado a 2026-09-21 (API publica de solo lectura), tal como
 * las publica Player-Inventory. Fija la tabla de §10.2 del contrato: 10 soportadas y 14 no.
 * Si el Catalog cambia, cambia esta tabla y el contrato, no el codigo.
 */
describe('evaluateSkill — el Catalog desplegado (24 habilidades, contrato §10.2)', () => {
  const mod = (
    statistic: string,
    magnitude: CombatAbilityEffect['magnitude'],
    extra: Partial<CombatAbilityEffect> = {},
    target = 'SELF',
  ): CombatAbilityEffect => ({
    kind: 'STAT_MODIFIER',
    target,
    statistic,
    operation: 'INCREASE',
    magnitude,
    hasActivationCondition: false,
    ...extra,
  })
  const other = (
    kind: string,
    target: string,
    extra: Partial<CombatAbilityEffect> = {},
  ): CombatAbilityEffect => ({ kind, target, hasActivationCondition: false, ...extra })

  const CATALOG: readonly (readonly [string, boolean, readonly CombatAbilityEffect[]])[] = [
    // Guerrero Tanque
    ['Golpe con escudo', true, [mod('ATTACK', fixed(2))]],
    ['Mano de piedra', false, [mod('DEFENSE', fixed(12))]],
    ['Defensa feroz', false, [other('IMMUNITY', 'SELF')]],
    // Guerrero Armas
    ['Embate sangriento', true, [mod('ATTACK', fixed(2)), mod('DAMAGE', fixed(1))]],
    ['Lanza de los dioses', true, [mod('DAMAGE', fixed(2))]],
    ['Golpe de tormenta', true, [mod('ATTACK', dice(3, 6)), mod('DAMAGE', fixed(2))]],
    // Mago Fuego
    ['Misiles de magma', true, [mod('ATTACK', fixed(1)), mod('DAMAGE', fixed(2))]],
    ['Vulcano', true, [mod('ATTACK', fixed(3)), mod('DAMAGE', dice(3, 9))]],
    [
      'Pare de fuego',
      false,
      [
        mod('ATTACK', fixed(1)),
        other('REFLECT_DAMAGE', 'OPPONENT', {
          magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
          hasActivationCondition: true,
        }),
      ],
    ],
    // Mago Hielo
    ['Lluvia de hielo', true, [mod('ATTACK', fixed(2)), mod('DAMAGE', fixed(2))]],
    [
      'Cono de hielo',
      false,
      [
        mod('DAMAGE', fixed(2)),
        mod('ATTACK', dice(1, 3), { operation: 'DECREASE', durationTurns: 2 }, 'OPPONENT'),
      ],
    ],
    [
      'Bola de hielo',
      false,
      [mod('ATTACK', fixed(2)), mod('DAMAGE', dice(1, 4), { operation: 'DECREASE' }, 'OPPONENT')],
    ],
    // Picaro Veneno
    ['Flor de loto', true, [mod('DAMAGE', dice(4, 8))]],
    ['Agonia', false, [other('DAMAGE', 'OPPONENT', { magnitude: dice(2, 9) })]],
    [
      'Piquete',
      false,
      [
        mod('ATTACK', fixed(1), { durationTurns: 2 }),
        mod('DAMAGE', fixed(2), { durationTurns: 1 }),
      ],
    ],
    // Picaro Machete
    ['Cortada', false, [mod('DAMAGE', fixed(2), { durationTurns: 2 })]],
    ['Machetazo', true, [mod('DAMAGE', dice(2, 8)), mod('ATTACK', fixed(1))]],
    ['Planazo', true, [mod('ATTACK', dice(2, 8)), mod('DAMAGE', fixed(1))]],
    // Chaman
    ['Toque de la Vida', false, [mod('HEALING', fixed(2))]],
    ['Vinculo Natural', false, [mod('HEALING', fixed(2), { durationTurns: 2 })]],
    [
      'Canto del Bosque',
      false,
      [other('HEALING', 'ALLIED_GROUP', { magnitude: dice(2, 6), durationTurns: 2 })],
    ],
    // Medico
    ['Curacion Directa', false, [mod('HEALING', fixed(2))]],
    ['Neutralizacion de Efectos', false, [mod('HEALING', fixed(2)), mod('HEALING', dice(2, 4))]],
    [
      'Reanimacion',
      true,
      [other('REVIVE', 'ALLY', { magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 } })],
    ],
  ]

  it('hay 24 habilidades', () => {
    expect(CATALOG).toHaveLength(24)
  })

  it.each(CATALOG)('%s -> soportada: %s', (name, expected, effects) => {
    expect(evaluateSkill({ ...SHIELD_STRIKE, name, effects }).supported).toBe(expected)
  })

  // Excepcion de curacion de HU-12 (sin Task de Management): Reanimacion pasa de
  // no soportada a soportada. Las otras 23 no cambian.
  it('11 de 24 estan soportadas (10 ofensivas + Reanimacion)', () => {
    expect(CATALOG.filter(([, isSupported]) => isSupported)).toHaveLength(11)
  })
})
