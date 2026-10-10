import type { NeuralInferencePort } from '../../src/application/ports/NeuralInferencePort'
import { FEATURE_DIMENSION } from '../../src/application/services/FeatureEncoderV1'
import {
  PARITY_REFERENCE_SCHEMA_VERSION,
  ParityReferenceMismatchError,
  assertSameTrainingRun,
  runParityValidation,
  type ParityReference,
} from '../../src/evaluation/parity/OnnxPytorchParityValidator'

class FakeInferencePort implements NeuralInferencePort {
  constructor(private readonly behavior: (features: Float32Array, count: number) => Float32Array) {}

  score(features: Float32Array, count: number): Promise<Float32Array> {
    return Promise.resolve(this.behavior(features, count))
  }
}

const vector = (value: number): readonly number[] =>
  Array.from({ length: FEATURE_DIMENSION }, () => value)

const buildReference = (
  cases: ParityReference['cases'],
  overrides: Partial<ParityReference> = {},
): ParityReference => ({
  schemaVersion: PARITY_REFERENCE_SCHEMA_VERSION,
  modelStateSha256: 'state-hash',
  onnxArtifactSha256: 'onnx-hash',
  featureSchemaVersion: 'feature-schema-v1',
  featureDimension: FEATURE_DIMENSION,
  cases,
  ...overrides,
})

describe('runParityValidation (EN-036.5, Management #569 §86-98)', () => {
  it('PA-03/PA-04/PA-06: scores finitos, shape correcta, pasa dentro de tolerancia con argmax de acuerdo', async () => {
    const reference = buildReference([
      { caseId: 'c1', candidateFeatures: [vector(0.1), vector(0.2)], pytorchScores: [0.3, 0.9] },
    ])
    const inference = new FakeInferencePort(() => Float32Array.from([0.3, 0.9]))

    const report = await runParityValidation(reference, inference)

    expect(report.passed).toBe(true)
    expect(report.argmaxAgreement).toBe(1)
    expect(report.scoresCompared).toBe(2)
    expect(Number.isFinite(report.maxAbsoluteError)).toBe(true)
  })

  it('PA-05: una diferencia mayor que atol/rtol marca passed=false', async () => {
    const reference = buildReference([
      { caseId: 'c1', candidateFeatures: [vector(0.1)], pytorchScores: [0.5] },
    ])
    const inference = new FakeInferencePort(() => Float32Array.from([0.5 + 1e-2]))

    const report = await runParityValidation(reference, inference)

    expect(report.passed).toBe(false)
    expect(report.maxAbsoluteError).toBeGreaterThan(report.atol)
  })

  it('PA-06: argmax en desacuerdo marca passed=false aunque los scores esten cerca', async () => {
    const reference = buildReference([
      {
        caseId: 'c1',
        candidateFeatures: [vector(0.1), vector(0.2)],
        pytorchScores: [0.50001, 0.5],
      },
    ])
    // ONNX invierte cual es mayor, dentro de tolerancia absoluta pero cambia el argmax.
    const inference = new FakeInferencePort(() => Float32Array.from([0.5, 0.50001]))

    const report = await runParityValidation(reference, inference)

    expect(report.argmaxAgreement).toBe(0)
    expect(report.passed).toBe(false)
  })

  it('multiples casos: argmaxAgreement es la fraccion de casos con acuerdo, no de scores', async () => {
    const reference = buildReference([
      { caseId: 'agree', candidateFeatures: [vector(0.1), vector(0.2)], pytorchScores: [0.1, 0.9] },
      {
        caseId: 'disagree',
        candidateFeatures: [vector(0.1), vector(0.2)],
        pytorchScores: [0.9, 0.1],
      },
    ])
    const inference = new FakeInferencePort((_features, count) =>
      count === 2 ? Float32Array.from([0.1, 0.9]) : Float32Array.from([0]),
    )

    const report = await runParityValidation(reference, inference)

    expect(report.argmaxAgreement).toBe(0.5)
  })

  it('PA-02/PA-07: assertSameTrainingRun rechaza una referencia de OTRO modelo (hash distinto)', () => {
    const reference = buildReference([])
    expect(() => {
      assertSameTrainingRun(reference, {
        modelStateSha256: 'otro-hash',
        onnxArtifactSha256: 'onnx-hash',
      })
    }).toThrow(ParityReferenceMismatchError)
    expect(() => {
      assertSameTrainingRun(reference, {
        modelStateSha256: 'state-hash',
        onnxArtifactSha256: 'otro-onnx',
      })
    }).toThrow(ParityReferenceMismatchError)
    expect(() => {
      assertSameTrainingRun(reference, {
        modelStateSha256: 'state-hash',
        onnxArtifactSha256: 'onnx-hash',
      })
    }).not.toThrow()
  })
})
