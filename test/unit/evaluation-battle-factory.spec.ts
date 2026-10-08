import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { BattleRoomStatus } from '../../src/domain/value-objects/BattleRoomStatus'
import {
  buildEvaluationBattleRoom,
  EVALUATION_TEAM_A_LABEL,
  EVALUATION_TEAM_B_LABEL,
} from '../../src/evaluation/battle/EvaluationBattleFactory'
import { EVALUATION_SCENARIOS } from '../../src/evaluation/battle/EvaluationScenarioCatalog'

const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const AT = new Date('2027-01-01T00:00:00.000Z')

const scenario = (id: string) => {
  const found = EVALUATION_SCENARIOS.find((candidate) => candidate.scenarioId === id)
  if (found === undefined) throw new Error(`escenario de prueba no encontrado: ${id}`)
  return found
}

describe('buildEvaluationBattleRoom (EN-036.5, Management #569 §40)', () => {
  it('construye una sala IN_BATTLE 1v1 legal, con ambos combatientes presentes', () => {
    const basic = scenario('basic-attack-mirror')
    const room = buildEvaluationBattleRoom({
      roomIdSeed: 'eval-room:test-1',
      teamAProfile: basic.teamAProfile,
      teamBProfile: basic.teamBProfile,
      turnOrderSequence: factory.create(RandomSeed.create(1)),
      at: AT,
    })

    expect(room.status).toBe(BattleRoomStatus.InBattle)
    expect(room.battle).not.toBeNull()
    const combatants = room.battle?.combatants ?? []
    expect(combatants).toHaveLength(2)
    expect(combatants.map((c) => c.teamLabel).sort()).toEqual([
      EVALUATION_TEAM_A_LABEL,
      EVALUATION_TEAM_B_LABEL,
    ])
  })

  it('cada escenario del catalogo produce una sala IN_BATTLE legal', () => {
    for (const candidate of EVALUATION_SCENARIOS) {
      const room = buildEvaluationBattleRoom({
        roomIdSeed: `eval-room:${candidate.scenarioId}`,
        teamAProfile: candidate.teamAProfile,
        teamBProfile: candidate.teamBProfile,
        turnOrderSequence: factory.create(RandomSeed.create(42)),
        at: AT,
      })

      expect(room.status).toBe(BattleRoomStatus.InBattle)
    }
  })

  it('distintas semillas de orden de turno pueden producir distinto equipo inicial', () => {
    const basic = scenario('basic-attack-mirror')
    const build = (seed: number) =>
      buildEvaluationBattleRoom({
        roomIdSeed: `eval-room:order-${String(seed)}`,
        teamAProfile: basic.teamAProfile,
        teamBProfile: basic.teamBProfile,
        turnOrderSequence: factory.create(RandomSeed.create(seed)),
        at: AT,
      }).battle?.currentEntry.teamLabel

    const seeds = Array.from({ length: 20 }, (_, i) => i + 1)
    const firstTeams = new Set(seeds.map(build))

    expect(firstTeams.size).toBeGreaterThan(1)
  })
})
