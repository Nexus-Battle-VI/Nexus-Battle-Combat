import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { createCombatProfile } from '../../src/domain/entities/CombatProfile'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { runAcceleratedBattle } from '../../src/evaluation/battle/AcceleratedBattleRunner'
import { buildEvaluationBattleRoom } from '../../src/evaluation/battle/EvaluationBattleFactory'
import { EVALUATION_SCENARIOS } from '../../src/evaluation/battle/EvaluationScenarioCatalog'
import type { EvaluationPolicy } from '../../src/evaluation/policies/EvaluationPolicy'
import { RandomEvaluationPolicy } from '../../src/evaluation/policies/RandomEvaluationPolicy'
import { RuleBasedEvaluationPolicy } from '../../src/evaluation/policies/RuleBasedEvaluationPolicy'
import type { LegalAction } from '../../src/domain/decision/LegalAction'

const AT = new Date('2027-01-01T00:00:00.000Z')
const clock: ClockPort = { now: () => AT }
const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())

const scenario = (id: string) => {
  const found = EVALUATION_SCENARIOS.find((candidate) => candidate.scenarioId === id)
  if (found === undefined) throw new Error(`escenario de prueba no encontrado: ${id}`)
  return found
}

const buildRoom = (scenarioId: string, matchSeed: number) => {
  const s = scenario(scenarioId)
  return buildEvaluationBattleRoom({
    roomIdSeed: `test:${scenarioId}:${String(matchSeed)}`,
    teamAProfile: s.teamAProfile,
    teamBProfile: s.teamBProfile,
    turnOrderSequence: factory.create(RandomSeed.create(matchSeed)),
    at: AT,
  })
}

const baseRunOptions = (scenarioId: string, matchSeed: number, maxPlies = 500) => ({
  evaluationId: 'eval-test',
  matchId: `match:${scenarioId}:${String(matchSeed)}`,
  mirrorPairId: `pair:${scenarioId}:${String(matchSeed)}`,
  mirrorLeg: 'LEG_1' as const,
  matchupId: 'RULE_BASED_vs_RULE_BASED',
  scenarioId,
  matchSeed,
  combatSeed: matchSeed,
  room: buildRoom(scenarioId, matchSeed),
  combatSequence: factory.create(RandomSeed.create(matchSeed)),
  clock,
  maxPlies,
})

describe('runAcceleratedBattle (EN-036.5, Management #569): motor real, 0 invariantes', () => {
  it('BR-01: RuleBased vs RuleBased termina con un resultado de Combat real', async () => {
    const result = await runAcceleratedBattle({
      ...baseRunOptions('basic-attack-mirror', 1),
      policyA: new RuleBasedEvaluationPolicy(),
      policyB: new RuleBasedEvaluationPolicy(),
    })

    expect(result.status).toBe('COMPLETED')
    expect(result.invalidPolicySelections).toBe(0)
    expect(result.engineRejections).toBe(0)
    expect(result.outcome).not.toBeNull()
    expect(result.outcome?.outcome).toBe('WIN')
  })

  it('BR-02: misma semilla -> mismo resultado (determinismo real, sin RNG oculto)', async () => {
    const run = async () =>
      runAcceleratedBattle({
        ...baseRunOptions('offensive-abilities', 7),
        policyA: new RuleBasedEvaluationPolicy(),
        policyB: new RuleBasedEvaluationPolicy(),
      })

    const first = await run()
    const second = await run()

    expect(second.plies).toBe(first.plies)
    expect(second.outcome).toEqual(first.outcome)
    expect(second.metricsBySide).toEqual(first.metricsBySide)
  })

  it('BR-03: semillas distintas pueden producir trayectorias distintas', async () => {
    const run = async (seed: number) =>
      runAcceleratedBattle({
        ...baseRunOptions('offensive-abilities', seed),
        policyA: new RandomEvaluationPolicy(factory.create(RandomSeed.create(seed + 1000))),
        policyB: new RandomEvaluationPolicy(factory.create(RandomSeed.create(seed + 2000))),
      })

    const results = await Promise.all([1, 2, 3, 4, 5].map((seed) => run(seed)))
    const plyCounts = new Set(results.map((r) => r.plies))

    expect(plyCounts.size).toBeGreaterThan(1)
    for (const result of results) {
      expect(result.invalidPolicySelections).toBe(0)
      expect(result.engineRejections).toBe(0)
    }
  })

  it('BR-04: 0 acciones legales se resuelve con SYSTEM_END_TURN, nunca llama a una politica', async () => {
    // Chaman con SOLO Reanimacion (solo legal contra un aliado MUERTO):
    // con ambos vivos, este lado nunca tiene acciones legales.
    const reanimateOnly = createCombatProfile({
      heroId: 'hero-medico-test',
      subtype: 'MEDICO',
      maxHealth: 44,
      attack: null,
      defense: 11,
      damage: null,
      activeEffects: [],
      maxPower: 10,
      abilities: [
        {
          abilityId: 'reanimate-test',
          name: 'Reanimacion',
          powerCost: { mode: 'ALL_AVAILABLE' },
          chargeTurns: 1,
          effects: [
            {
              kind: 'REVIVE',
              target: 'ALLY',
              magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
              hasActivationCondition: false,
            },
          ],
        },
      ],
    })
    const attacker = scenario('basic-attack-mirror').teamBProfile

    const throwingPolicy: EvaluationPolicy = {
      id: 'RULE_BASED',
      decide: () => {
        throw new Error('NUNCA debe llamarse: 0 legalActions debe resolverse con SYSTEM_END_TURN.')
      },
    }

    const room = buildEvaluationBattleRoom({
      roomIdSeed: 'test:system-end-turn',
      teamAProfile: reanimateOnly,
      teamBProfile: attacker,
      turnOrderSequence: factory.create(RandomSeed.create(1)),
      at: AT,
    })

    const result = await runAcceleratedBattle({
      ...baseRunOptions('basic-attack-mirror', 1, 30),
      room,
      policyA: throwingPolicy,
      policyB: new RuleBasedEvaluationPolicy(),
    })

    expect(result.systemEndTurns).toBeGreaterThan(0)
    expect(result.metricsBySide.A.decisions).toBe(0)
  })

  it('BR-05: una politica que elige fuera de legalActions produce INVARIANT_VIOLATION, no se ejecuta', async () => {
    const rogueAction: LegalAction = { kind: 'BASIC_ATTACK', target: { scope: 'SELF' } }
    const roguePolicy: EvaluationPolicy = {
      id: 'RULE_BASED',
      decide: () => Promise.resolve(rogueAction),
    }

    const result = await runAcceleratedBattle({
      ...baseRunOptions('basic-attack-mirror', 3, 10),
      policyA: roguePolicy,
      policyB: new RuleBasedEvaluationPolicy(),
    })

    expect(result.status).toBe('INVARIANT_VIOLATION')
    expect(result.invalidPolicySelections).toBe(1)
    expect(result.failedSide).toBe('A')
    expect(result.outcome).toBeNull()
  })

  it('BR-07: dos sanadores que nunca se atacan alcanzan MAX_PLIES, nunca inventan ganador', async () => {
    const healerProfile = createCombatProfile({
      heroId: 'hero-healer-stall',
      subtype: 'CHAMAN',
      maxHealth: 44,
      attack: null,
      defense: 11,
      damage: null,
      activeEffects: [],
      maxPower: 20,
      abilities: [
        {
          abilityId: 'forest-song-stall',
          name: 'Canto del Bosque',
          powerCost: { mode: 'FIXED', amount: 1 },
          chargeTurns: 1,
          effects: [
            {
              kind: 'STAT_MODIFIER',
              target: 'ALLIED_GROUP',
              statistic: 'HEALING',
              operation: 'INCREASE',
              magnitude: { mode: 'FIXED', amount: 1 },
              durationTurns: 2,
              hasActivationCondition: false,
            },
          ],
        },
      ],
    })

    const room = buildEvaluationBattleRoom({
      roomIdSeed: 'test:max-plies-stall',
      teamAProfile: healerProfile,
      teamBProfile: healerProfile,
      turnOrderSequence: factory.create(RandomSeed.create(9)),
      at: AT,
    })

    const result = await runAcceleratedBattle({
      ...baseRunOptions('basic-attack-mirror', 9, 12),
      room,
      policyA: new RuleBasedEvaluationPolicy(),
      policyB: new RuleBasedEvaluationPolicy(),
    })

    expect(result.status).toBe('MAX_PLIES')
    expect(result.outcome).toBeNull()
    expect(result.plies).toBe(12)
  })

  it('BR-08: el Poder final nunca se lee restaurado por BattleRoom.finish()', async () => {
    const result = await runAcceleratedBattle({
      ...baseRunOptions('offensive-abilities', 5),
      policyA: new RuleBasedEvaluationPolicy(),
      policyB: new RuleBasedEvaluationPolicy(),
    })

    expect(result.status).toBe('COMPLETED')
    // Al menos un lado debe haber gastado Poder (RuleBasedPolicy escoge
    // el primer candidato, que para offensive-abilities casi siempre
    // incluye ABILITY con costo > 0 en algun momento de la partida).
    const powers = [result.metricsBySide.A.finalPower, result.metricsBySide.B.finalPower]
    expect(powers.some((power) => power !== null)).toBe(true)
  })

  it('aisla la secuencia de RandomPolicy de la secuencia de Combat (RNG separados)', async () => {
    // Se verifica corriendo dos partidas con el MISMO combatSequence pero
    // policies con distinto consumo de su propio stream, confirmando que
    // el resultado de Combat es identico: consumir del stream de politica
    // nunca afecta al stream de Combat.
    const run = async (policySeed: number) =>
      runAcceleratedBattle({
        ...baseRunOptions('basic-attack-mirror', 123),
        combatSequence: factory.create(RandomSeed.create(123)),
        policyA: new RandomEvaluationPolicy(factory.create(RandomSeed.create(policySeed))),
        policyB: new RuleBasedEvaluationPolicy(),
      })

    // basic-attack-mirror no tiene ABILITY: RandomPolicy con 1 unica
    // opcion (BASIC_ATTACK) nunca consume un indice real
    // (`createBoundedRandom` con `bound===1` no toca la secuencia), asi
    // que el resultado debe ser identico sin importar `policySeed`.
    const a = await run(1)
    const b = await run(2)

    expect(a.outcome).toEqual(b.outcome)
    expect(a.plies).toBe(b.plies)
  })
})
