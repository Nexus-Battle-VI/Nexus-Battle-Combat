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
 * estadistico, no una aserción determinista) -- solo documenta la relacion
 * estructural: el espacio de candidatos que MCTS explora es EXACTAMENTE el
 * mismo que consultarian esos pisos, y la accion de `RuleBasedPolicy` (la
 * primera legal, determinista) siempre aparece entre los candidatos de MCTS.
 */
describe('MctsSearch vs. RuleBasedPolicy/RandomPolicy (comparacion basica, EN-036.1)', () => {
  it('el conjunto de candidatos de MCTS coincide con el espacio que ven RuleBasedPolicy/RandomPolicy, y la eleccion de RuleBasedPolicy siempre esta entre ellos', async () => {
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

    // RuleBasedPolicy (el piso productivo real) siempre es una de las acciones
    // que MCTS evaluo -- nunca algo fuera de su alcance.
    expect(mctsCandidateIdentities.has(legalActionIdentity(ruleBasedChoice))).toBe(true)
    // Lo mismo para RandomPolicy (el piso experimental de EN-035.3).
    expect(mctsCandidateIdentities.has(legalActionIdentity(randomChoice))).toBe(true)

    // La accion seleccionada por el teacher es, por construccion, una candidata real.
    expect(legalIdentities.has(legalActionIdentity(teacherResult.selectedAction))).toBe(true)
  })
})
