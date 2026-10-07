import { legalActionIdentity } from '../../src/domain/decision/ActionIdentity'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import { InMemoryMctsSimulationAdapter } from '../../src/adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { MctsSearch } from '../../src/application/services/MctsSearch'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import { BattleDecisionStateAssembler } from '../../src/application/services/BattleDecisionStateAssembler'
import { createBoundedRandom } from '../../src/application/services/BoundedRandom'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { RandomPolicy } from '../../src/application/policies/RandomPolicy'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { battleWithSkills } from '../fixtures/skills'
import { clock } from '../fixtures/battle'

/**
 * Evidencia esperada de EN-036.1 (Management Task #565): una comparacion
 * basica entre el teacher MCTS y los dos "pisos" ya existentes (el fallback
 * productivo `RuleBasedPolicy` y el piso experimental `RandomPolicy` de
 * EN-035.3). No afirma que MCTS "juegue mejor" (séria un resultado
 * estadistico, no una aserción determinista) -- reporta, para el MISMO
 * estado, que decision tomaria cada politica y que utilidad le asigna el
 * teacher a esa MISMA decision (no solo que vean el mismo espacio de
 * acciones, ampliacion pedida en la revision de PR#80).
 */
describe('MctsSearch vs. RuleBasedPolicy/RandomPolicy (comparacion basica, EN-036.1)', () => {
  it('reporta la decision y la utilidad del teacher para RuleBasedPolicy y RandomPolicy sobre el mismo estado', async () => {
    const room = battleWithSkills()
    const legalActionGenerator = new LegalActionGenerator()
    const legalActions = legalActionGenerator.generateAvailable(room)
    const state = new BattleDecisionStateAssembler().assemble(room)

    const ruleBasedChoice = await new RuleBasedPolicy().decide(state, legalActions)
    const randomPolicySequence = new Mt19937BoxMullerRandomSequenceFactory(
      new CdfUniformIndexMapper(),
    ).create(RandomSeed.create(7))
    const randomChoice = await new RandomPolicy(createBoundedRandom(randomPolicySequence)).decide(
      state,
      legalActions,
    )

    const simulation = new InMemoryMctsSimulationAdapter(clock)
    const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
    const search = new MctsSearch(simulation, factory)
    const teacherResult = await search.search(
      room,
      { ...MCTS_TEACHER_V1_CONFIG, rollouts: 64 },
      3_000_000,
    )

    const mctsCandidateIdentities = new Set(teacherResult.candidates.map((c) => c.actionIdentity))
    const legalIdentities = new Set(legalActions.map((action) => legalActionIdentity(action)))

    // Mismo espacio de busqueda: ni MCTS inventa candidatos fuera de lo legal,
    // ni deja fuera ninguna accion que RuleBasedPolicy/RandomPolicy podrian elegir.
    expect(mctsCandidateIdentities).toEqual(legalIdentities)

    // Para CADA piso, el teacher tiene una opinion explicita (visits/meanUtility)
    // sobre la MISMA decision que ese piso tomaria -- no solo "la vio", sino que
    // la evaluo con rollouts reales y puede compararla con su propia eleccion.
    const ruleBasedCandidate = teacherResult.candidates.find(
      (c) => c.actionIdentity === legalActionIdentity(ruleBasedChoice),
    )
    const randomCandidate = teacherResult.candidates.find(
      (c) => c.actionIdentity === legalActionIdentity(randomChoice),
    )
    const selectedCandidate = teacherResult.candidates.find(
      (c) => c.actionIdentity === legalActionIdentity(teacherResult.selectedAction),
    )

    expect(ruleBasedCandidate).toBeDefined()
    expect(randomCandidate).toBeDefined()
    expect(selectedCandidate).toBeDefined()

    for (const candidate of [ruleBasedCandidate, randomCandidate, selectedCandidate]) {
      expect(candidate?.visits).toBeGreaterThan(0)
      expect(candidate?.meanUtility).toBeGreaterThanOrEqual(0)
      expect(candidate?.meanUtility).toBeLessThanOrEqual(1)
    }

    // La accion que el teacher selecciona es la de MAS visitas (desempate
    // determinista): nunca por debajo de las demas en ese mismo criterio.
    const maxVisits = Math.max(...teacherResult.candidates.map((c) => c.visits))
    expect(selectedCandidate?.visits).toBe(maxVisits)
  })
})
