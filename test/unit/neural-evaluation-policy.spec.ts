import { NeuralPolicy } from '../../src/application/policies/NeuralPolicy'
import type { NeuralInferencePort } from '../../src/application/ports/NeuralInferencePort'
import { NeuralInferenceTimeoutError } from '../../src/domain/errors/NeuralPolicyErrors'
import { buildEvaluationBattleRoom } from '../../src/evaluation/battle/EvaluationBattleFactory'
import { EVALUATION_SCENARIOS } from '../../src/evaluation/battle/EvaluationScenarioCatalog'
import { NeuralEvaluationPolicy } from '../../src/evaluation/policies/NeuralEvaluationPolicy'
import { FeatureEncoderV1 } from '../../src/application/services/FeatureEncoderV1'
import { BattleDecisionStateAssembler } from '../../src/application/services/BattleDecisionStateAssembler'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { legalActionIdentity } from '../../src/domain/decision/ActionIdentity'

const AT = new Date('2027-01-01T00:00:00.000Z')
const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const legalActionGenerator = new LegalActionGenerator()
const assembler = new BattleDecisionStateAssembler()

class FakeInferencePort implements NeuralInferencePort {
  constructor(
    private readonly behavior: (count: number) => Promise<Float32Array> | Float32Array,
  ) {}

  async score(_features: Float32Array, count: number): Promise<Float32Array> {
    const result = this.behavior(count)
    return result instanceof Float32Array ? result : await result
  }
}

const buildContext = () => {
  const s = EVALUATION_SCENARIOS.find((candidate) => candidate.scenarioId === 'offensive-abilities')
  if (s === undefined) throw new Error('escenario de prueba no encontrado')

  const room = buildEvaluationBattleRoom({
    roomIdSeed: 'test:neural-evaluation-policy',
    teamAProfile: s.teamAProfile,
    teamBProfile: s.teamBProfile,
    turnOrderSequence: factory.create(RandomSeed.create(1)),
    at: AT,
  })
  const legalActions = legalActionGenerator.generateAvailable(room)
  const state = assembler.assemble(room)

  return {
    room,
    state,
    legalActions,
    matchSeed: 1,
    decisionIndex: 0,
    side: 'A' as const,
  }
}

const descriptor = {
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  modelStateSha256: 'fake-state-hash',
  onnxArtifactSha256: 'fake-onnx-hash',
  artifactPurpose: 'SMOKE_TEST',
}

describe('NeuralEvaluationPolicy (EN-036.5, Management #569 §17-18)', () => {
  it('decide() devuelve una accion legal usando el runtime REAL de NeuralPolicy (#568)', async () => {
    const port = new FakeInferencePort((count) => new Float32Array(count).fill(0.5))
    const inner = new NeuralPolicy(new FeatureEncoderV1(), port, 50)
    const policy = new NeuralEvaluationPolicy(inner, descriptor)
    const context = buildContext()

    const chosen = await policy.decide(context)

    expect(context.legalActions.map(legalActionIdentity)).toContain(legalActionIdentity(chosen))
  })

  it('un timeout/fallo de inferencia se propaga TAL CUAL -- nunca cae a RuleBased en silencio', async () => {
    const port = new FakeInferencePort(
      () =>
        new Promise<Float32Array>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('caido'))
          }, 500).unref()
        }),
    )
    const inner = new NeuralPolicy(new FeatureEncoderV1(), port, 10)
    const policy = new NeuralEvaluationPolicy(inner, descriptor)
    const context = buildContext()

    await expect(policy.decide(context)).rejects.toBeInstanceOf(NeuralInferenceTimeoutError)
  })

  it('expone el modelDescriptor del artefacto que envuelve', () => {
    const port = new FakeInferencePort((count) => new Float32Array(count).fill(0))
    const inner = new NeuralPolicy(new FeatureEncoderV1(), port, 50)
    const policy = new NeuralEvaluationPolicy(inner, descriptor)

    expect(policy.modelDescriptor).toBe(descriptor)
    expect(policy.id).toBe('NEURAL')
  })
})
