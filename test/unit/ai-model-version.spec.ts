import {
  AiModelVersion,
  type AiModelArtifactLineage,
  type AiModelTrainingLineage,
} from '../../src/domain/entities/AiModelVersion'
import { AiModelState } from '../../src/domain/value-objects/AiModelState'
import {
  ArtifactPurposeNotCandidateError,
  CorruptAiModelVersionError,
  InvalidModelStateTransitionError,
  ModelSchemaIncompatibleError,
} from '../../src/domain/errors/AiModelRegistryErrors'

const AT = new Date('2027-01-01T00:00:00.000Z')
const LATER = new Date('2027-01-01T01:00:00.000Z')

const hex = (digit: string): string => digit.repeat(64)

const trainingLineage: AiModelTrainingLineage = {
  modelVersion: 'candidate-mlp-v1-abc123def456',
  trainingRunId: 'candidate-mlp-v1-abc123def456',
  modelArchitectureVersion: 'candidate-mlp-v1',
  featureSchemaVersion: 'feature-schema-v1',
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  trainingSourceCommit: 'a1b2c3',
  datasetSourceCommit: 'd4e5f6',
  datasetInputFingerprint: hex('1'),
  datasetOutputFingerprint: hex('2'),
  datasetCutoff: '2027-01-01T00:00:00Z',
  datasetSeed: 42,
  // Deliberadamente distinto de `datasetSeed` (revision de codigo, #570):
  // nunca se debe asumir que ambos coinciden solo porque hoy sea comodo.
  trainingSeed: 7,
  trainingConfigSha256: hex('3'),
}

const candidateArtifactLineage: AiModelArtifactLineage = {
  modelStateSha256: hex('4'),
  onnxArtifactSha256: hex('5'),
  pytorchArtifactSha256: hex('6'),
  metricsFileSha256: hex('7'),
  artifactPurpose: 'CANDIDATE',
  trainingManifestSha256: hex('8'),
  trainingConfig: { trainingSeed: 7 },
  datasetCounts: { battles: 4 },
  metrics: { testLoss: 0.1 },
}

describe('AiModelVersion (EN-037.1, Management #570 §9-19, §49-58)', () => {
  it('MR-01: startTraining crea TRAINING, revision 0, con historial inicial', () => {
    const version = AiModelVersion.startTraining(trainingLineage, AT)

    expect(version.state).toBe(AiModelState.Training)
    expect(version.revision).toBe(0)
    expect(version.artifactLineage).toBeNull()
    expect(version.stateHistory).toEqual([{ from: null, to: AiModelState.Training, at: AT }])
    expect(version.createdAt).toEqual(AT)
    expect(version.updatedAt).toEqual(AT)
  })

  it('MR-02: TRAINING -> CANDIDATE liga el artifact lineage e incrementa revision', () => {
    const training = AiModelVersion.startTraining(trainingLineage, AT)
    const candidate = training.registerCandidate(candidateArtifactLineage, LATER)

    expect(candidate.state).toBe(AiModelState.Candidate)
    expect(candidate.revision).toBe(1)
    expect(candidate.artifactLineage).toEqual(candidateArtifactLineage)
    expect(candidate.updatedAt).toEqual(LATER)
  })

  it('MR-03: CANDIDATE -> EVALUATING', () => {
    const evaluating = AiModelVersion.startTraining(trainingLineage, AT)
      .registerCandidate(candidateArtifactLineage, AT)
      .beginEvaluation(LATER)

    expect(evaluating.state).toBe(AiModelState.Evaluating)
    expect(evaluating.revision).toBe(2)
  })

  it('MR-04: EVALUATING -> ACTIVE', () => {
    const active = AiModelVersion.startTraining(trainingLineage, AT)
      .registerCandidate(candidateArtifactLineage, AT)
      .beginEvaluation(AT)
      .activate(LATER)

    expect(active.state).toBe(AiModelState.Active)
    expect(active.revision).toBe(3)
  })

  it('MR-05: EVALUATING -> REJECTED guarda reasonCode/reason/rejectedAt', () => {
    const rejected = AiModelVersion.startTraining(trainingLineage, AT)
      .registerCandidate(candidateArtifactLineage, AT)
      .beginEvaluation(AT)
      .reject('EVALUATION_FAILED', 'el harness no produjo un resultado valido', LATER)

    expect(rejected.state).toBe(AiModelState.Rejected)
    expect(rejected.rejection).toEqual({
      reasonCode: 'EVALUATION_FAILED',
      reason: 'el harness no produjo un resultado valido',
      rejectedAt: LATER,
    })
  })

  it('MR-06: TRAINING -> ACTIVE directo se rechaza', () => {
    const training = AiModelVersion.startTraining(trainingLineage, AT)
    expect(() => training.activate(LATER)).toThrow(InvalidModelStateTransitionError)
  })

  it('MR-07: CANDIDATE -> ACTIVE directo se rechaza (debe pasar por EVALUATING)', () => {
    const candidate = AiModelVersion.startTraining(trainingLineage, AT).registerCandidate(
      candidateArtifactLineage,
      AT,
    )
    expect(() => candidate.activate(LATER)).toThrow(InvalidModelStateTransitionError)
  })

  it('MR-08: REJECTED -> ACTIVE/CANDIDATE se rechazan (terminal)', () => {
    const rejected = AiModelVersion.startTraining(trainingLineage, AT).reject(
      'TRAINING_FAILED',
      'divergencia numerica',
      AT,
    )
    expect(() => rejected.activate(LATER)).toThrow(InvalidModelStateTransitionError)
    expect(() => rejected.registerCandidate(candidateArtifactLineage, LATER)).toThrow(
      InvalidModelStateTransitionError,
    )
  })

  it('TRAINING -> REJECTED esta permitida (training que fallo, #570 §13)', () => {
    const rejected = AiModelVersion.startTraining(trainingLineage, AT).reject(
      'TRAINING_FAILED',
      'el proceso de entrenamiento no converge',
      LATER,
    )
    expect(rejected.state).toBe(AiModelState.Rejected)
  })

  it('CANDIDATE -> REJECTED esta permitida (validacion previa a evaluacion, #570 §13)', () => {
    const rejected = AiModelVersion.startTraining(trainingLineage, AT)
      .registerCandidate(candidateArtifactLineage, AT)
      .reject('ARTIFACT_INVALID', 'schema incompatible detectado antes de evaluar', LATER)
    expect(rejected.state).toBe(AiModelState.Rejected)
  })

  it('MR-09: el lineage de training es inmutable a traves de toda la ruta', () => {
    const training = AiModelVersion.startTraining(trainingLineage, AT)
    const candidate = training.registerCandidate(candidateArtifactLineage, AT)
    const evaluating = candidate.beginEvaluation(AT)
    const active = evaluating.activate(AT)

    expect(training.trainingLineage).toEqual(trainingLineage)
    expect(candidate.trainingLineage).toEqual(trainingLineage)
    expect(evaluating.trainingLineage).toEqual(trainingLineage)
    expect(active.trainingLineage).toEqual(trainingLineage)
  })

  it('MR-10: stateHistory queda en orden, cada "from" coincide con el "to" anterior', () => {
    const active = AiModelVersion.startTraining(trainingLineage, AT)
      .registerCandidate(candidateArtifactLineage, AT)
      .beginEvaluation(AT)
      .activate(AT)

    const history = active.stateHistory
    expect(history).toHaveLength(4)
    for (let i = 1; i < history.length; i += 1) {
      expect(history[i]?.from).toBe(history[i - 1]?.to)
    }
    expect(history[0]).toEqual({ from: null, to: AiModelState.Training, at: AT })
    expect(history[history.length - 1]?.to).toBe(AiModelState.Active)
  })

  it('MR-11: revision incrementa exactamente 1 por transicion', () => {
    const training = AiModelVersion.startTraining(trainingLineage, AT)
    const candidate = training.registerCandidate(candidateArtifactLineage, AT)
    const evaluating = candidate.beginEvaluation(AT)
    const active = evaluating.activate(AT)

    expect([training.revision, candidate.revision, evaluating.revision, active.revision]).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('revision de codigo (#570): SMOKE_TEST NUNCA puede registrarse como CANDIDATE', () => {
    const training = AiModelVersion.startTraining(trainingLineage, AT)
    const smokeArtifactLineage: AiModelArtifactLineage = {
      ...candidateArtifactLineage,
      artifactPurpose: 'SMOKE_TEST',
    }

    expect(() => training.registerCandidate(smokeArtifactLineage, AT)).toThrow(
      ArtifactPurposeNotCandidateError,
    )
    // El training permanece intacto (nunca una CANDIDATE a medias).
    expect(training.state).toBe(AiModelState.Training)
  })

  it('revision de codigo (#570 §17): "modelVersion" distinto de "trainingRunId" se rechaza', () => {
    expect(() =>
      AiModelVersion.startTraining({ ...trainingLineage, trainingRunId: 'otro-run-id' }, AT),
    ).toThrow(TypeError)
  })

  it('activate() sin artifact lineage se rechaza siempre (defensa en profundidad)', () => {
    // No deberia ser alcanzable por el grafo de transiciones (CANDIDATE siempre liga
    // artifact lineage), pero la invariante se comprueba de todas formas en `activate()`.
    const evaluatingWithoutArtifact = AiModelVersion.restore({
      trainingLineage,
      artifactLineage: null,
      state: AiModelState.Evaluating,
      revision: 2,
      createdAt: AT,
      updatedAt: AT,
      stateHistory: [
        { from: null, to: AiModelState.Training, at: AT },
        { from: AiModelState.Training, to: AiModelState.Candidate, at: AT },
        { from: AiModelState.Candidate, to: AiModelState.Evaluating, at: AT },
      ],
      rejection: null,
    })

    expect(() => evaluatingWithoutArtifact.activate(LATER)).toThrow(ModelSchemaIncompatibleError)
  })

  describe('restore() revalida invariantes semanticas ante corrupcion (#570 §34, revision de codigo)', () => {
    const validHistory = [
      { from: null, to: AiModelState.Training, at: AT },
      { from: AiModelState.Training, to: AiModelState.Candidate, at: AT },
      { from: AiModelState.Candidate, to: AiModelState.Evaluating, at: AT },
    ]

    it('rechaza modelVersion !== trainingRunId', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage: { ...trainingLineage, modelVersion: 'otro' },
          artifactLineage: null,
          state: AiModelState.Training,
          revision: 0,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: [{ from: null, to: AiModelState.Training, at: AT }],
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza una revision negativa', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: null,
          state: AiModelState.Training,
          revision: -1,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: [{ from: null, to: AiModelState.Training, at: AT }],
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza un stateHistory cuyo ultimo "to" no coincide con "state"', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: null,
          state: AiModelState.Evaluating,
          revision: 2,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: validHistory,
          rejection: null,
        }),
      ).not.toThrow()

      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: null,
          state: AiModelState.Candidate,
          revision: 2,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: validHistory,
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza una transicion invalida dentro del historial (p. ej. TRAINING -> ACTIVE directo)', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: candidateArtifactLineage,
          state: AiModelState.Active,
          revision: 1,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: [
            { from: null, to: AiModelState.Training, at: AT },
            { from: AiModelState.Training, to: AiModelState.Active, at: AT },
          ],
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza ACTIVE sin artifact lineage', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: null,
          state: AiModelState.Active,
          revision: 3,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: [
            ...validHistory,
            { from: AiModelState.Evaluating, to: AiModelState.Active, at: AT },
          ],
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza un artifactLineage con artifactPurpose distinto de CANDIDATE', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: { ...candidateArtifactLineage, artifactPurpose: 'SMOKE_TEST' },
          state: AiModelState.Candidate,
          revision: 1,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: validHistory.slice(0, 2),
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza REJECTED sin informacion de rechazo', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: null,
          state: AiModelState.Rejected,
          revision: 1,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: [
            { from: null, to: AiModelState.Training, at: AT },
            { from: AiModelState.Training, to: AiModelState.Rejected, at: AT },
          ],
          rejection: null,
        }),
      ).toThrow(CorruptAiModelVersionError)
    })

    it('rechaza un estado no terminal con informacion de rechazo presente', () => {
      expect(() =>
        AiModelVersion.restore({
          trainingLineage,
          artifactLineage: null,
          state: AiModelState.Training,
          revision: 0,
          createdAt: AT,
          updatedAt: AT,
          stateHistory: [{ from: null, to: AiModelState.Training, at: AT }],
          rejection: { reasonCode: 'TRAINING_FAILED', reason: 'x', rejectedAt: AT },
        }),
      ).toThrow(CorruptAiModelVersionError)
    })
  })
})
