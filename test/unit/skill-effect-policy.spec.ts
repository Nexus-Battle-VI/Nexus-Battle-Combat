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
 * Que efectos de una habilidad sabe ejecutar Combat (HU-19, contrato `hu-19-skills-v2`, sucesor
 * de `hu-19-skills-v1` §10.2). v1 solo soportaba el patron «+N (o +NdM) al Ataque / al Dano»
 * propio (sin duracion ni condicion) y la excepcion de curacion de Reanimacion; v2 amplia el
 * patron declarativo (§1) a `DEFENSE`, a `target: OPPONENT` con `DECREASE`, a `kind: DAMAGE`
 * directo, a `REFLECT_DAMAGE`, a `IMMUNITY` estructural y a `HEALING` (instantanea y con
 * duracion, sobre un aliado o el grupo aliado). Todo lo demas se sigue rechazando de forma
 * explicita.
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

describe('evaluateSkill — habilidades soportadas (patron DAMAGE, v1 sin cambios)', () => {
  it('Golpe con escudo: +2 al Ataque, sin bono de Dano', () => {
    expect(supported(SHIELD_STRIKE)).toEqual({
      supported: true,
      kind: 'DAMAGE',
      attackBonus: { fixed: 2, dice: [] },
      damageBonus: { fixed: 0, dice: [] },
      reflect: null,
      temporalEffects: [],
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
    [
      'una sanacion (HEALING) sobre un objetivo que no es aliado ni grupo aliado',
      effect({ kind: 'HEALING', target: 'ALLIED_GROUP' }),
    ],
    ['una inmunidad sin immunityCode', effect({ kind: 'IMMUNITY', magnitude: undefined })],
    ['una inmunidad con magnitud (no se amplia ese esquema)', effect({ kind: 'IMMUNITY' })],
    [
      'un reflejo de dano sin su condicion de activacion',
      effect({
        kind: 'REFLECT_DAMAGE',
        target: 'OPPONENT',
        magnitude: { mode: 'PERCENTAGE', basisPoints: 5000 },
      }),
    ],
    [
      'una reanimacion (REVIVE) con magnitud FIXED',
      effect({ kind: 'REVIVE', target: 'ALLY', magnitude: fixed(2) }),
    ],
    [
      'un estado temporal de kind desconocido',
      effect({ kind: 'TEMPORARY_STATUS', durationTurns: 2 }),
    ],
    ['un modificador de ATTACK sobre un aliado', effect({ target: 'ALLY' })],
    ['un modificador de ATTACK sobre un grupo aliado', effect({ target: 'ALLIED_GROUP' })],
    ['un producto (MULTIPLY)', effect({ operation: 'MULTIPLY' })],
    ['un valor fijado (SET)', effect({ operation: 'SET' })],
    ['la Sanacion sobre uno mismo (solo aliado o grupo aliado)', effect({ statistic: 'HEALING' })],
    ['el Poder', effect({ statistic: 'POWER' })],
    ['la Vida', effect({ statistic: 'HEALTH' })],
    ['el critico', effect({ statistic: 'CRITICAL_CHANCE' })],
    ['un efecto sin estadistica', effect({ statistic: undefined })],
    [
      'una condicion de activacion en un modificador de estadistica',
      effect({ hasActivationCondition: true }),
    ],
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
      abilityWith([attackBonus(fixed(2)), damageBonus(fixed(1)), effect({ target: 'ALLY' })]),
    )

    expect(result.supported).toBe(false)
  })

  it('una habilidad sin efectos no esta soportada (no se inventa uno)', () => {
    expect(evaluateSkill(abilityWith([])).supported).toBe(false)
  })

  it('Mano de piedra CON condicion y duracion (fixture historica de v1) no esta soportada', () => {
    // DEFENSE ya es una estadistica soportada en v2 (ver describe de abajo); STONE_HAND sigue
    // rechazada por su condicion de activacion, nunca definida formalmente (mismo motivo que
    // cualquier STAT_MODIFIER condicionado).
    const result = evaluateSkill(STONE_HAND)

    expect(result.supported).toBe(false)
    expect(result).toMatchObject({ reason: expect.stringContaining('condicionado') })
  })

  it('el motivo se explica en el resultado (para el registro, nunca para el cliente)', () => {
    const result = evaluateSkill(abilityWith([effect({ hasActivationCondition: true })]))

    expect(result).toEqual({
      supported: false,
      reason: 'un efecto condicionado no se evalua: la condicion no esta definida formalmente.',
    })
  })

  it('mezclar dano directo con otros patrones no esta soportado (no se aplica a medias)', () => {
    const result = evaluateSkill(
      abilityWith([
        {
          kind: 'DAMAGE',
          target: 'OPPONENT',
          magnitude: dice(2, 9),
          hasActivationCondition: false,
        },
        attackBonus(fixed(1)),
      ]),
    )

    expect(result.supported).toBe(false)
  })

  it('mezclar sanacion con patrones ofensivos no esta soportado (no se aplica a medias)', () => {
    const result = evaluateSkill(
      abilityWith([
        {
          kind: 'STAT_MODIFIER',
          target: 'ALLY',
          statistic: 'HEALING',
          operation: 'INCREASE',
          magnitude: fixed(2),
          hasActivationCondition: false,
        },
        attackBonus(fixed(1)),
      ]),
    )

    expect(result.supported).toBe(false)
  })

  it('mas de un reflejo de dano por habilidad no esta definido', () => {
    const reflect = (): CombatAbilityEffect => ({
      kind: 'REFLECT_DAMAGE',
      target: 'OPPONENT',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 5000 },
      hasActivationCondition: true,
    })
    const result = evaluateSkill(abilityWith([reflect(), reflect()]))

    expect(result.supported).toBe(false)
  })
})

/**
 * HU-19 v2 (contrato §1): `statistic: DEFENSE` en el MISMO patron `STAT_MODIFIER` que ya
 * soportaba `ATTACK`/`DAMAGE` -- solo se amplia el enum aceptado, ninguna logica especial por
 * habilidad. Soporta Mano de piedra (Tabla 7): sin duracion declarada, el efecto se adjunta
 * como estado temporal de UN turno propio del propio actor (contrato §2, sin inventar una
 * magnitud: el minimo estructural para que exista, no una cifra de la Tabla 7).
 */
describe('evaluateSkill — STAT_MODIFIER · DEFENSE (v2, Mano de piedra)', () => {
  const defenseBonus = (extra: Partial<CombatAbilityEffect> = {}): CombatAbilityEffect => ({
    kind: 'STAT_MODIFIER',
    target: 'SELF',
    statistic: 'DEFENSE',
    operation: 'INCREASE',
    magnitude: fixed(12),
    hasActivationCondition: false,
    ...extra,
  })

  it('un +12 a la Defensa propia, sin duracion, es un efecto temporal soportado', () => {
    const result = evaluateSkill(abilityWith([defenseBonus()]))

    expect(result).toMatchObject({
      supported: true,
      kind: 'DAMAGE',
      temporalEffects: [
        {
          family: 'STAT',
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          audience: 'SELF',
          bonus: { fixed: 12, dice: [] },
          durationTurns: null,
        },
      ],
    })
  })

  it('DEFENSE con operation DECREASE (generico) tambien esta soportado', () => {
    expect(evaluateSkill(abilityWith([defenseBonus({ operation: 'DECREASE' })])).supported).toBe(
      true,
    )
  })

  it('DEFENSE sobre un aliado o un grupo aliado no esta definido', () => {
    expect(evaluateSkill(abilityWith([defenseBonus({ target: 'ALLY' })])).supported).toBe(false)
    expect(evaluateSkill(abilityWith([defenseBonus({ target: 'ALLIED_GROUP' })])).supported).toBe(
      false,
    )
  })
})

/**
 * HU-19 v2 (contrato §1 y §6): `target: OPPONENT` con `operation: DECREASE` en `STAT_MODIFIER` --
 * el mismo patron generico soporta Cono de hielo (con duracion) y Bola de hielo (sin duracion,
 * `SUPPORTED_UNCONFIRMED_MAGNITUDE`: el motor ejecuta lo que Catalog declara, sin confirmar que
 * `1d4` sea el valor de Tabla 7).
 */
describe('evaluateSkill — STAT_MODIFIER · target OPPONENT · DECREASE (v2, Cono de hielo / Bola de hielo)', () => {
  const oppDecrease = (
    statistic: string,
    extra: Partial<CombatAbilityEffect> = {},
  ): CombatAbilityEffect => ({
    kind: 'STAT_MODIFIER',
    target: 'OPPONENT',
    statistic,
    operation: 'DECREASE',
    magnitude: dice(1, 3),
    hasActivationCondition: false,
    ...extra,
  })

  it('ATTACK con duracion (Cono de hielo) esta soportado', () => {
    const result = evaluateSkill(abilityWith([oppDecrease('ATTACK', { durationTurns: 2 })]))

    expect(result).toMatchObject({
      supported: true,
      temporalEffects: [{ audience: 'OPPONENT', operation: 'DECREASE', durationTurns: 2 }],
    })
  })

  it('DAMAGE sin duracion (Bola de hielo) tambien esta soportado -- ejecutable, magnitud sin confirmar', () => {
    const result = evaluateSkill(abilityWith([oppDecrease('DAMAGE')]))

    expect(result).toMatchObject({
      supported: true,
      temporalEffects: [{ audience: 'OPPONENT', operation: 'DECREASE', durationTurns: null }],
    })
  })
})

/** HU-19 v2 (contrato §3): `kind: DAMAGE` directo sobre el oponente, sin resolucion de Ataque/Defensa. */
describe('evaluateSkill — kind DAMAGE directo (v2, Agonia)', () => {
  const direct = (extra: Partial<CombatAbilityEffect> = {}): CombatAbilityEffect => ({
    kind: 'DAMAGE',
    target: 'OPPONENT',
    magnitude: dice(2, 9),
    hasActivationCondition: false,
    ...extra,
  })

  it('esta soportado como kind DIRECT_DAMAGE, con su bono agregado', () => {
    expect(evaluateSkill(abilityWith([direct()]))).toEqual({
      supported: true,
      kind: 'DIRECT_DAMAGE',
      damageBonus: { fixed: 0, dice: [{ count: 2, sides: 9 }] },
    })
  })

  it('sobre uno mismo o un aliado no esta definido', () => {
    expect(evaluateSkill(abilityWith([direct({ target: 'SELF' })])).supported).toBe(false)
    expect(evaluateSkill(abilityWith([direct({ target: 'ALLY' })])).supported).toBe(false)
  })

  it('con duracion o condicion no esta definido', () => {
    expect(evaluateSkill(abilityWith([direct({ durationTurns: 1 })])).supported).toBe(false)
    expect(evaluateSkill(abilityWith([direct({ hasActivationCondition: true })])).supported).toBe(
      false,
    )
  })
})

/**
 * HU-19 v2 (contrato §6): `kind: REFLECT_DAMAGE`, `target: OPPONENT`, magnitud `PERCENTAGE`,
 * `hasActivationCondition: true` -- la condicion ES el patron ("recibio dano en su turno propio
 * anterior"). Junto al patron 1 (ATTACK +1 self), soporta Pare de fuego.
 */
describe('evaluateSkill — kind REFLECT_DAMAGE (v2, Pare de fuego)', () => {
  const reflect = (extra: Partial<CombatAbilityEffect> = {}): CombatAbilityEffect => ({
    kind: 'REFLECT_DAMAGE',
    target: 'OPPONENT',
    magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
    hasActivationCondition: true,
    ...extra,
  })

  it('Pare de fuego (ATTACK +1 self, reflejo 100%) esta soportado', () => {
    const result = evaluateSkill(abilityWith([attackBonus(fixed(1)), reflect()]))

    expect(result).toMatchObject({
      supported: true,
      kind: 'DAMAGE',
      attackBonus: { fixed: 1, dice: [] },
      reflect: { basisPoints: 10_000 },
    })
  })

  it('sin su condicion de activacion no esta soportado', () => {
    expect(evaluateSkill(abilityWith([reflect({ hasActivationCondition: false })])).supported).toBe(
      false,
    )
  })

  it('sobre uno mismo no esta definido', () => {
    expect(evaluateSkill(abilityWith([reflect({ target: 'SELF' })])).supported).toBe(false)
  })

  it('con magnitud fuera de PERCENTAGE 1..10000 no esta soportado', () => {
    expect(evaluateSkill(abilityWith([reflect({ magnitude: fixed(1) })])).supported).toBe(false)
    expect(
      evaluateSkill(abilityWith([reflect({ magnitude: { mode: 'PERCENTAGE', basisPoints: 0 } })]))
        .supported,
    ).toBe(false)
  })
})

/**
 * HU-19 v2 (contrato §5): `kind: IMMUNITY`, `target: SELF`, `immunityCode` presente, SIN
 * `magnitude`. Soporte ESTRUCTURAL: por si sola no resuelve Defensa feroz (ver el CATALOG de
 * abajo, con su segundo componente sin `kind` formal).
 */
describe('evaluateSkill — kind IMMUNITY (v2, estructural)', () => {
  const immunity = (extra: Partial<CombatAbilityEffect> = {}): CombatAbilityEffect => ({
    kind: 'IMMUNITY',
    target: 'SELF',
    immunityCode: 'PHYSICAL_DAMAGE',
    hasActivationCondition: false,
    ...extra,
  })

  it('con immunityCode y sin magnitud esta soportada (como UNICO efecto de la habilidad)', () => {
    const result = evaluateSkill(abilityWith([immunity()]))

    expect(result).toMatchObject({
      supported: true,
      kind: 'DAMAGE',
      temporalEffects: [{ family: 'IMMUNITY', immunityCode: 'PHYSICAL_DAMAGE' }],
    })
  })

  it('sin immunityCode no esta soportada', () => {
    expect(evaluateSkill(abilityWith([immunity({ immunityCode: undefined })])).supported).toBe(
      false,
    )
  })

  it('con magnitud no esta soportada (no se amplia ese esquema)', () => {
    expect(evaluateSkill(abilityWith([immunity({ magnitude: fixed(1) })])).supported).toBe(false)
  })

  it('sobre el oponente no esta definida', () => {
    expect(evaluateSkill(abilityWith([immunity({ target: 'OPPONENT' })])).supported).toBe(false)
  })
})

/**
 * HU-19 v2 (contrato §1): `statistic: HEALING` en `STAT_MODIFIER`, `target ∈ {ALLY,
 * ALLIED_GROUP}` -- generaliza el patron HEAL de PERCENTAGE-only (REVIVE) a FIXED/DICE, con o
 * sin duracion. Soporta Toque de la Vida, Curacion Directa, Neutralizacion de Efectos
 * (instantaneas), Vinculo Natural y Canto del Bosque (con duracion: efecto temporal, no
 * instantaneo -- contrato §2, "no se aplica a medias" entre lo instantaneo y lo persistido).
 */
describe('evaluateSkill — STAT_MODIFIER · HEALING (v2)', () => {
  const heal = (
    magnitude: CombatAbilityEffect['magnitude'],
    extra: Partial<CombatAbilityEffect> = {},
    target = 'ALLY',
  ): CombatAbilityEffect => ({
    kind: 'STAT_MODIFIER',
    target,
    statistic: 'HEALING',
    operation: 'INCREASE',
    magnitude,
    hasActivationCondition: false,
    ...extra,
  })

  it('una sanacion instantanea (sin duracion) esta soportada, kind HEALING, audiencia ALLY', () => {
    expect(evaluateSkill(abilityWith([heal(fixed(2))]))).toEqual({
      supported: true,
      kind: 'HEALING',
      audience: 'ALLY',
      healBonus: { fixed: 2, dice: [] },
      temporalEffects: [],
    })
  })

  it('dos efectos de sanacion instantanea se AGREGAN (Neutralizacion de Efectos)', () => {
    const result = evaluateSkill(abilityWith([heal(fixed(2)), heal(dice(2, 4))]))

    expect(result).toMatchObject({
      supported: true,
      kind: 'HEALING',
      healBonus: { fixed: 2, dice: [{ count: 2, sides: 4 }] },
    })
  })

  it('una sanacion CON duracion (Vinculo Natural) es un efecto temporal, no instantaneo', () => {
    const result = evaluateSkill(abilityWith([heal(fixed(2), { durationTurns: 2 })]))

    expect(result).toEqual({
      supported: true,
      kind: 'HEALING',
      audience: 'ALLY',
      healBonus: { fixed: 0, dice: [] },
      temporalEffects: [
        {
          family: 'STAT',
          statistic: 'HEALING',
          operation: 'INCREASE',
          audience: 'ALLY',
          bonus: { fixed: 2, dice: [] },
          durationTurns: 2,
        },
      ],
    })
  })

  it('sobre el grupo aliado (Canto del Bosque) esta soportada con audiencia ALLIED_GROUP', () => {
    const result = evaluateSkill(
      abilityWith([heal(dice(2, 6), { durationTurns: 2 }, 'ALLIED_GROUP')]),
    )

    expect(result).toMatchObject({ supported: true, kind: 'HEALING', audience: 'ALLIED_GROUP' })
  })

  it('sobre uno mismo o el oponente no esta definida', () => {
    expect(evaluateSkill(abilityWith([heal(fixed(2), {}, 'SELF')])).supported).toBe(false)
    expect(evaluateSkill(abilityWith([heal(fixed(2), {}, 'OPPONENT')])).supported).toBe(false)
  })

  it('con DECREASE no esta definida', () => {
    expect(evaluateSkill(abilityWith([heal(fixed(2), { operation: 'DECREASE' })])).supported).toBe(
      false,
    )
  })

  it('mezclar sanacion con y sin duracion no es un problema: cada efecto es independiente', () => {
    const result = evaluateSkill(
      abilityWith([heal(fixed(2)), heal(fixed(3), { durationTurns: 1 })]),
    )

    expect(result).toMatchObject({
      supported: true,
      healBonus: { fixed: 2, dice: [] },
      temporalEffects: [{ bonus: { fixed: 3, dice: [] }, durationTurns: 1 }],
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
 * las publica Player-Inventory. Fija la tabla de §7 del contrato v2: 23 ejecutables (21
 * `SUPPORTED` conforme al PDF + 2 `SUPPORTED_UNCONFIRMED_MAGNITUDE`, Pare de fuego y Bola de
 * hielo -- ver el describe dedicado arriba, ningun test de este archivo afirma que su magnitud
 * sea la correcta de Tabla 7) y 1 `PENDING_SOURCE_DEFINITION` (Defensa feroz: su componente
 * fisico de inmunidad SI encaja en el patron nuevo, pero el componente magico "(3d6) al dano
 * magico" no tiene `kind` ni campo formal en el contrato de Producto -- "no se aplica a medias"
 * bloquea la habilidad completa). Si el Catalog cambia, cambia esta tabla y el contrato, no el
 * codigo.
 */
describe('evaluateSkill — el Catalog desplegado (24 habilidades, contrato v2 §7)', () => {
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
    ['Mano de piedra', true, [mod('DEFENSE', fixed(12))]],
    [
      'Defensa feroz',
      false,
      [
        other('IMMUNITY', 'SELF', { immunityCode: 'PHYSICAL_DAMAGE' }),
        // El componente magico "(3d6) al dano magico" no tiene kind ni campo formal en el
        // contrato de Producto (v2 §5): se codifica con una estadistica que la politica NO
        // reconoce -- Catalog no puede publicar algo mas preciso sin inventarlo.
        mod('MAGIC_DAMAGE_MITIGATION', dice(3, 6)),
      ],
    ],
    // Guerrero Armas
    ['Embate sangriento', true, [mod('ATTACK', fixed(2)), mod('DAMAGE', fixed(1))]],
    ['Lanza de los dioses', true, [mod('DAMAGE', fixed(2))]],
    ['Golpe de tormenta', true, [mod('ATTACK', dice(3, 6)), mod('DAMAGE', fixed(2))]],
    // Mago Fuego
    ['Misiles de magma', true, [mod('ATTACK', fixed(1)), mod('DAMAGE', fixed(2))]],
    ['Vulcano', true, [mod('ATTACK', fixed(3)), mod('DAMAGE', dice(3, 9))]],
    [
      'Pare de fuego',
      true,
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
      true,
      [
        mod('DAMAGE', fixed(2)),
        mod('ATTACK', dice(1, 3), { operation: 'DECREASE', durationTurns: 2 }, 'OPPONENT'),
      ],
    ],
    [
      'Bola de hielo',
      true,
      [mod('ATTACK', fixed(2)), mod('DAMAGE', dice(1, 4), { operation: 'DECREASE' }, 'OPPONENT')],
    ],
    // Picaro Veneno
    ['Flor de loto', true, [mod('DAMAGE', dice(4, 8))]],
    ['Agonia', true, [other('DAMAGE', 'OPPONENT', { magnitude: dice(2, 9) })]],
    [
      'Piquete',
      true,
      [
        mod('ATTACK', fixed(1), { durationTurns: 2 }),
        mod('DAMAGE', fixed(2), { durationTurns: 1 }),
      ],
    ],
    // Picaro Machete
    ['Cortada', true, [mod('DAMAGE', fixed(2), { durationTurns: 2 })]],
    ['Machetazo', true, [mod('DAMAGE', dice(2, 8)), mod('ATTACK', fixed(1))]],
    ['Planazo', true, [mod('ATTACK', dice(2, 8)), mod('DAMAGE', fixed(1))]],
    // Chaman
    ['Toque de la Vida', true, [mod('HEALING', fixed(2), {}, 'ALLY')]],
    ['Vinculo Natural', true, [mod('HEALING', fixed(2), { durationTurns: 2 }, 'ALLY')]],
    ['Canto del Bosque', true, [mod('HEALING', dice(2, 6), { durationTurns: 2 }, 'ALLIED_GROUP')]],
    // Medico
    ['Curacion Directa', true, [mod('HEALING', fixed(2), {}, 'ALLY')]],
    [
      'Neutralizacion de Efectos',
      true,
      [mod('HEALING', fixed(2), {}, 'ALLY'), mod('HEALING', dice(2, 4), {}, 'ALLY')],
    ],
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

  it('23 de 24 son ejecutables (21 SUPPORTED + 2 SUPPORTED_UNCONFIRMED_MAGNITUDE); solo Defensa feroz queda bloqueada', () => {
    expect(CATALOG.filter(([, isSupported]) => isSupported)).toHaveLength(23)
    expect(CATALOG.filter(([, isSupported]) => !isSupported).map(([name]) => name)).toEqual([
      'Defensa feroz',
    ])
  })
})
