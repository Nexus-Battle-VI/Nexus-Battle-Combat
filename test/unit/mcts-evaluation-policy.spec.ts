import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { InMemoryMctsSimulationAdapter } from '../../src/adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { BattleDecisionStateAssembler } from '../../src/application/services/BattleDecisionStateAssembler'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import { MctsSearch } from '../../src/application/services/MctsSearch'
import { MctsTeacher } from '../../src/application/services/MctsTeacher'
import { legalActionIdentity } from '../../src/domain/decision/ActionIdentity'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import { NoStrategicMctsCandidatesError } from '../../src/domain/errors/MctsErrors'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { buildEvaluationBattleRoom } from '../../src/evaluation/battle/EvaluationBattleFactory'
import { EVALUATION_SCENARIOS } from '../../src/evaluation/battle/EvaluationScenarioCatalog'
import { MctsEvaluationPolicy } from '../../src/evaluation/policies/MctsEvaluationPolicy'

const AT = new Date('2027-01-01T00:00:00.000Z')
const clock: ClockPort = { now: () => AT }
const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const legalActionGenerator = new LegalActionGenerator()
const assembler = new BattleDecisionStateAssembler()

const scenario = (id: string) => {
  const found = EVALUATION_SCENARIOS.find((candidate) => candidate.scenarioId === id)
  if (found === undefined) throw new Error(`escenario de prueba no encontrado: ${id}`)
  return found
}

const buildTeacher = (rollouts: number) => {
  const simulation = new InMemoryMctsSimulationAdapter(clock)
  const search = new MctsSearch(simulation, factory)
  return new MctsTeacher(search, { ...MCTS_TEACHER_V1_CONFIG, rollouts })
}

describe('MctsEvaluationPolicy (EN-036.5, Management #569 §19-21, §110)', () => {
  it('decide() devuelve una accion legal (resuelta) sobre el motor real', async () => {
    const s = scenario('offensive-abilities')
    const room = buildEvaluationBattleRoom({
      roomIdSeed: 'test:mcts-legal-1',
      teamAProfile: s.teamAProfile,
      teamBProfile: s.teamBProfile,
      turnOrderSequence: factory.create(RandomSeed.create(1)),
      at: AT,
    })

    const legalActions = legalActionGenerator.generateAvailable(room)
    const state = assembler.assemble(room)
    const policy = new MctsEvaluationPolicy(buildTeacher(16))

    const chosen = await policy.decide({
      room,
      state,
      legalActions,
      matchSeed: 1,
      decisionIndex: 0,
      side: 'A',
    })

    expect(legalActions.map(legalActionIdentity)).toContain(legalActionIdentity(chosen))
  })

  it('usa una semilla NUEVA por decisionIndex (dos llamadas con distinto decisionIndex pueden divergir en candidatos evaluados sin romper legalidad)', async () => {
    const s = scenario('offensive-abilities')
    const room = buildEvaluationBattleRoom({
      roomIdSeed: 'test:mcts-seed-per-decision',
      teamAProfile: s.teamAProfile,
      teamBProfile: s.teamBProfile,
      turnOrderSequence: factory.create(RandomSeed.create(2)),
      at: AT,
    })
    const legalActions = legalActionGenerator.generateAvailable(room)
    const state = assembler.assemble(room)
    const policy = new MctsEvaluationPolicy(buildTeacher(16))

    const first = await policy.decide({ room, state, legalActions, matchSeed: 5, decisionIndex: 0, side: 'A' })
    const second = await policy.decide({ room, state, legalActions, matchSeed: 5, decisionIndex: 1, side: 'A' })

    expect(legalActions.map(legalActionIdentity)).toContain(legalActionIdentity(first))
    expect(legalActions.map(legalActionIdentity)).toContain(legalActionIdentity(second))
  })

  it('NoStrategicMctsCandidatesError se propaga tal cual (nunca cae a RuleBased en silencio, #569 §21)', async () => {
    // Soporte con Canto del Bosque como UNICA accion legal, equipo propio al
    // 100% de Vida: MCTS lo filtra como curacion no estrategica (umbral
    // 90%) y debe lanzar NoStrategicMctsCandidatesError -- evidencia REAL
    // contra el motor, sin fabricar el error.
    const s = scenario('support-vs-offensive')
    let found: Awaited<ReturnType<typeof buildEvaluationBattleRoom>> | null = null

    for (let seed = 1; seed <= 20; seed += 1) {
      const room = buildEvaluationBattleRoom({
        roomIdSeed: `test:mcts-no-strategic-${String(seed)}`,
        teamAProfile: s.teamAProfile,
        teamBProfile: s.teamBProfile,
        turnOrderSequence: factory.create(RandomSeed.create(seed)),
        at: AT,
      })

      if (room.battle?.currentEntry.teamLabel === 'A') {
        found = room
        break
      }
    }

    if (found === null) {
      throw new Error('no se encontro una semilla donde el lado soporte (A) abra la cola de turnos')
    }

    const room = found
    const legalActions = legalActionGenerator.generateAvailable(room)
    expect(legalActions).toHaveLength(1)
    expect(legalActions[0]?.kind).toBe('ABILITY')

    const state = assembler.assemble(room)
    const policy = new MctsEvaluationPolicy(buildTeacher(16))

    await expect(
      policy.decide({ room, state, legalActions, matchSeed: 1, decisionIndex: 0, side: 'A' }),
    ).rejects.toBeInstanceOf(NoStrategicMctsCandidatesError)
  })
})
