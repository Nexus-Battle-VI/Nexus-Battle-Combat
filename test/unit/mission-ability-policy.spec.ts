import { evaluateMissionAbility } from '../../src/domain/policies/MissionAbilityPolicy'
import { evaluateSkill } from '../../src/domain/policies/SkillEffectPolicy'
import type {
  CombatAbility,
  CombatAbilityEffect,
  CombatMagnitude,
} from '../../src/domain/entities/CombatProfile'

const fixed = (amount: number): CombatMagnitude => ({ mode: 'FIXED', amount })
const dice = (count: number, sides: number): CombatMagnitude => ({ mode: 'DICE', count, sides })
const percent = (basisPoints: number): CombatMagnitude => ({ mode: 'PERCENTAGE', basisPoints })

const effect = (
  kind: string,
  target: string,
  extra: Partial<CombatAbilityEffect> = {},
): CombatAbilityEffect => ({ kind, target, hasActivationCondition: false, ...extra })
const modifier = (
  target: string,
  statistic: string,
  operation: 'INCREASE' | 'DECREASE',
  magnitude: CombatMagnitude,
  durationTurns?: number,
): CombatAbilityEffect =>
  effect('STAT_MODIFIER', target, {
    statistic,
    operation,
    magnitude,
    ...(durationTurns === undefined ? {} : { durationTurns }),
  })

const ability = (name: string, effects: readonly CombatAbilityEffect[]): CombatAbility => ({
  abilityId: name.toLowerCase().replaceAll(' ', '-'),
  name,
  powerCost: { mode: 'FIXED', amount: 2 },
  chargeTurns: 1,
  effects,
})

/**
 * Las 24 habilidades del Catalog de produccion (2026-09-24), con sus efectos tal
 * como los publica Player/Inventory. Es la prueba de que la mision ya no descarta
 * lo que un jugador real puede poner en su estrategia.
 */
const PRODUCTION: readonly CombatAbility[] = [
  ability('Agonía', [effect('DAMAGE', 'OPPONENT', { magnitude: dice(2, 9) })]),
  ability('Bola de hielo', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(2)),
    modifier('OPPONENT', 'DAMAGE', 'DECREASE', dice(1, 4)),
  ]),
  ability('Canto del Bosque', [
    effect('HEALING', 'ALLIED_GROUP', { magnitude: dice(2, 6), durationTurns: 2 }),
  ]),
  ability('Cono de hielo', [
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2)),
    modifier('OPPONENT', 'ATTACK', 'DECREASE', dice(1, 3), 2),
  ]),
  ability('Cortada', [modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2), 2)]),
  ability('Curación Directa', [modifier('SELF', 'HEALING', 'INCREASE', fixed(2))]),
  ability('Defensa feroz', [effect('IMMUNITY', 'SELF')]),
  ability('Embate sangriento', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(2)),
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(1)),
  ]),
  ability('Flor de loto', [modifier('SELF', 'DAMAGE', 'INCREASE', dice(4, 8))]),
  ability('Golpe con escudo', [modifier('SELF', 'ATTACK', 'INCREASE', fixed(2))]),
  ability('Golpe de tormenta', [
    modifier('SELF', 'ATTACK', 'INCREASE', dice(3, 6)),
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2)),
  ]),
  ability('Lanza de los dioses', [modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2))]),
  ability('Lluvia de hielo', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(2)),
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2)),
  ]),
  ability('Machetazo', [
    modifier('SELF', 'DAMAGE', 'INCREASE', dice(2, 8)),
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(1)),
  ]),
  ability('Mano de piedra', [modifier('SELF', 'DEFENSE', 'INCREASE', fixed(12))]),
  ability('Misiles de magma', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(1)),
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2)),
  ]),
  ability('Neutralización de Efectos', [
    modifier('SELF', 'HEALING', 'INCREASE', fixed(2)),
    modifier('SELF', 'HEALING', 'INCREASE', dice(2, 4)),
  ]),
  ability('Pare de fuego', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(1)),
    effect('REFLECT_DAMAGE', 'OPPONENT', {
      magnitude: percent(10_000),
      hasActivationCondition: true,
    }),
  ]),
  ability('Piquete', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(1), 2),
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(2), 1),
  ]),
  ability('Planazo', [
    modifier('SELF', 'ATTACK', 'INCREASE', dice(2, 8)),
    modifier('SELF', 'DAMAGE', 'INCREASE', fixed(1)),
  ]),
  ability('Reanimación', [effect('REVIVE', 'ALLY', { magnitude: percent(10_000) })]),
  ability('Toque de la Vida', [modifier('SELF', 'HEALING', 'INCREASE', fixed(2))]),
  ability('Vulcano', [
    modifier('SELF', 'ATTACK', 'INCREASE', fixed(3)),
    modifier('SELF', 'DAMAGE', 'INCREASE', dice(3, 9)),
  ]),
  ability('Vínculo Natural', [modifier('SELF', 'HEALING', 'INCREASE', fixed(2), 2)]),
]

const byName = (name: string): CombatAbility => {
  const found = PRODUCTION.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`Falta ${name} en la tabla de produccion.`)
  return found
}

describe('evaluateMissionAbility (P-J4)', () => {
  it('da semantica de mision a 23 de las 24 habilidades de produccion; solo falta la condicionada', () => {
    const unsupported = PRODUCTION.filter((entry) => !evaluateMissionAbility(entry).supported)

    expect(unsupported.map((entry) => entry.name)).toEqual(['Pare de fuego'])
  })

  it('las que PvP ya ejecutaba conservan las mismas bonificaciones, sin efectos extra', () => {
    for (const entry of PRODUCTION) {
      const pvp = evaluateSkill(entry)
      if (!pvp.supported || pvp.kind !== 'DAMAGE') continue
      const mission = evaluateMissionAbility(entry)

      expect(mission).toEqual({
        supported: true,
        attacks: true,
        attackBonus: pvp.attackBonus,
        damageBonus: pvp.damageBonus,
        effects: [],
      })
    }
  })

  it('el dano al oponente es dano directo, sin tirada de ataque', () => {
    expect(evaluateMissionAbility(byName('Agonía'))).toMatchObject({
      supported: true,
      attacks: false,
      effects: [{ kind: 'DIRECT_DAMAGE', amount: { fixed: 0, dice: [{ count: 2, sides: 9 }] } }],
    })
  })

  it('las curaciones curan al heroe, tambien en el tiempo y por porcentaje', () => {
    expect(evaluateMissionAbility(byName('Canto del Bosque'))).toMatchObject({
      attacks: false,
      effects: [{ kind: 'HEAL', turns: 2 }],
    })
    expect(evaluateMissionAbility(byName('Toque de la Vida'))).toMatchObject({
      effects: [{ kind: 'HEAL', amount: { fixed: 2, dice: [] }, turns: 1 }],
    })
    expect(evaluateMissionAbility(byName('Vínculo Natural'))).toMatchObject({
      effects: [{ kind: 'HEAL', turns: 2 }],
    })
    expect(evaluateMissionAbility(byName('Reanimación'))).toMatchObject({
      effects: [{ kind: 'HEAL_PERCENT', basisPoints: 10_000 }],
    })
  })

  it('las mejoras con duracion y la defensa son efectos, y siguen atacando si mejoran el golpe', () => {
    expect(evaluateMissionAbility(byName('Cortada'))).toMatchObject({
      attacks: true,
      effects: [{ kind: 'MODIFIER', target: 'SELF', statistic: 'DAMAGE', turns: 2 }],
    })
    expect(evaluateMissionAbility(byName('Piquete'))).toMatchObject({
      attacks: true,
      effects: [
        { kind: 'MODIFIER', target: 'SELF', statistic: 'ATTACK', turns: 2 },
        { kind: 'MODIFIER', target: 'SELF', statistic: 'DAMAGE', turns: 1 },
      ],
    })
    expect(evaluateMissionAbility(byName('Mano de piedra'))).toMatchObject({
      attacks: false,
      effects: [{ kind: 'MODIFIER', target: 'SELF', statistic: 'DEFENSE', turns: 1 }],
    })
  })

  it('las penalizaciones al oponente acompanan al golpe', () => {
    expect(evaluateMissionAbility(byName('Bola de hielo'))).toMatchObject({
      attacks: true,
      attackBonus: { fixed: 2, dice: [] },
      effects: [{ kind: 'MODIFIER', target: 'OPPONENT', statistic: 'DAMAGE', turns: 1 }],
    })
    expect(evaluateMissionAbility(byName('Cono de hielo'))).toMatchObject({
      damageBonus: { fixed: 2, dice: [] },
      effects: [{ kind: 'MODIFIER', target: 'OPPONENT', statistic: 'ATTACK', turns: 2 }],
    })
  })

  it('inmunidad y reflejo tienen duracion de una ronda si no declaran otra', () => {
    expect(evaluateMissionAbility(byName('Defensa feroz'))).toMatchObject({
      attacks: false,
      effects: [{ kind: 'IMMUNITY', turns: 1 }],
    })
    expect(
      evaluateMissionAbility(
        ability('Toma y lleva', [
          effect('REFLECT_DAMAGE', 'OPPONENT', { magnitude: percent(5000) }),
        ]),
      ),
    ).toMatchObject({ effects: [{ kind: 'REFLECT', basisPoints: 5000, turns: 1 }] })
  })

  it.each([
    ['sin efectos', ability('Vacia', [])],
    ['condicionado', byName('Pare de fuego')],
    ['Poder del enemigo', ability('Frio', [modifier('OPPONENT', 'POWER', 'DECREASE', fixed(1))])],
    [
      'estadistica desconocida',
      ability('Rara', [modifier('SELF', 'CRITICAL_CHANCE', 'INCREASE', fixed(1))]),
    ],
    ['mejora al enemigo', ability('Error', [modifier('OPPONENT', 'ATTACK', 'INCREASE', fixed(1))])],
    [
      'dano con duracion',
      ability('Veneno', [effect('DAMAGE', 'OPPONENT', { magnitude: fixed(2), durationTurns: 2 })]),
    ],
    [
      'dano a un aliado',
      ability('Fuego amigo', [effect('DAMAGE', 'ALLY', { magnitude: fixed(2) })]),
    ],
    [
      'curar al enemigo',
      ability('Mala cura', [effect('HEALING', 'OPPONENT', { magnitude: fixed(2) })]),
    ],
    [
      'reanimar sin porcentaje',
      ability('Reanima', [effect('REVIVE', 'ALLY', { magnitude: fixed(2) })]),
    ],
    ['inmunidad ajena', ability('Escudo', [effect('IMMUNITY', 'ALLY')])],
    [
      'reflejo sin porcentaje',
      ability('Espejo', [effect('REFLECT_DAMAGE', 'OPPONENT', { magnitude: fixed(1) })]),
    ],
    ['magnitud vacia', ability('Nada', [modifier('SELF', 'ATTACK', 'INCREASE', fixed(0))])],
    ['efecto desconocido', ability('Magia', [effect('TELEPORT', 'SELF')])],
  ])('rechaza con motivo: %s', (_case, entry) => {
    const support = evaluateMissionAbility(entry)

    expect(support.supported).toBe(false)
    if (!support.supported) expect(support.reason.length).toBeGreaterThan(0)
  })
})
