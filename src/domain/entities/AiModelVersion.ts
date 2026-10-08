import {
  AiModelState,
  isAllowedAiModelStateTransition,
  type AiModelState as AiModelStateType,
} from '../value-objects/AiModelState'
import { assertSha256Hex } from '../value-objects/Sha256Hex'
import {
  InvalidModelStateTransitionError,
  ModelSchemaIncompatibleError,
} from '../errors/AiModelRegistryErrors'

/**
 * `AiModelVersion` (EN-037.1, Management #570): identidad y ciclo de vida
 * de una version de modelo de IA de combate. El registry NO decide si un
 * modelo es bueno (#570 §136): solo garantiza que existe, es identificable,
 * integro, compatible, tiene lineage y un estado valido, y puede
 * activarse de forma segura. Gates/thresholds/promocion automatica son
 * `#572` (EN-037.3), nunca esta clase.
 *
 * `modelVersion` (la identidad, `_id` persistido) reutiliza DIRECTAMENTE
 * `trainingRunId` (#570 §17): Python ya deriva ese id de forma
 * determinista (`${modelArchitectureVersion}-${sha256(datasetOutputFingerprint
 * + ':' + trainingConfigSha256 + ':' + seed).slice(0,12)}`, ver
 * `ai/src/nexus_combat_ai/cli/train_model.py::_run_id`) -- nunca un UUID o
 * timestamp nuevo inventado aqui.
 *
 * Lineage dividido en dos partes, reflejando CUANDO cada dato existe de
 * verdad (#570 §9, §50):
 *
 *  - `AiModelTrainingLineage`: conocido ANTES de entrenar (el dataset
 *    congelado y la config de training ya existen, #571 los calculara
 *    antes de invocar `nexus-combat-train`). Se fija al crear la version
 *    en `TRAINING` y es inmutable para siempre.
 *  - `AiModelArtifactLineage`: solo existe DESPUES de entrenar (hashes del
 *    checkpoint/ONNX/metricas reales). Se fija UNA vez, en la transicion
 *    `TRAINING -> CANDIDATE`, y tambien es inmutable desde ese momento.
 */

export interface AiModelTrainingLineage {
  readonly modelVersion: string
  readonly trainingRunId: string
  readonly modelArchitectureVersion: string
  readonly featureSchemaVersion: string
  readonly teacherVersion: string
  readonly utilityVersion: string
  readonly trainingSourceCommit: string
  readonly datasetSourceCommit: string
  readonly datasetInputFingerprint: string
  readonly datasetOutputFingerprint: string
  readonly datasetCutoff: string
  readonly datasetSeed: number
  readonly trainingConfigSha256: string
}

/** `training-manifest-v1` solo declara estos dos valores (#567 §149-150); nunca se inventa un tercero. */
export type AiModelArtifactPurpose = 'SMOKE_TEST' | 'CANDIDATE'

export interface AiModelArtifactLineage {
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly pytorchArtifactSha256: string
  readonly metricsFileSha256: string
  readonly artifactPurpose: AiModelArtifactPurpose
}

export interface AiModelStateHistoryEntry {
  readonly from: AiModelStateType | null
  readonly to: AiModelStateType
  readonly at: Date
}

/** `WIN_RATE_TOO_LOW` y similares NO existen aqui a proposito (#570 §58): son de `#572`. */
export type AiModelRejectionReasonCode =
  'TRAINING_FAILED' | 'ARTIFACT_INVALID' | 'SCHEMA_INCOMPATIBLE' | 'EVALUATION_FAILED'

export interface AiModelRejection {
  readonly reasonCode: AiModelRejectionReasonCode
  readonly reason: string
  readonly rejectedAt: Date
}

interface AiModelVersionProps {
  readonly trainingLineage: AiModelTrainingLineage
  readonly artifactLineage: AiModelArtifactLineage | null
  readonly state: AiModelStateType
  readonly revision: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly stateHistory: readonly AiModelStateHistoryEntry[]
  readonly rejection: AiModelRejection | null
}

const assertTrainingLineage = (lineage: AiModelTrainingLineage): AiModelTrainingLineage => {
  if (lineage.modelVersion.trim().length === 0) {
    throw new TypeError('"modelVersion" no puede estar vacio.')
  }
  if (lineage.trainingRunId.trim().length === 0) {
    throw new TypeError('"trainingRunId" no puede estar vacio.')
  }
  assertSha256Hex(lineage.trainingConfigSha256, 'trainingConfigSha256')
  if (!Number.isInteger(lineage.datasetSeed) || lineage.datasetSeed < 0) {
    throw new TypeError('"datasetSeed" debe ser un entero no negativo.')
  }
  return lineage
}

/**
 * El parametro se recibe con `artifactPurpose` ampliado a `string` (en vez
 * de la union estrecha de `AiModelArtifactLineage`) para que esta
 * comprobacion en tiempo de ejecucion sea real y no redundante con el
 * tipo estatico: `AiModelRegistry.registerCandidate` lo construye con un
 * `as AiModelArtifactPurpose` sobre un valor que YA viene de fuera
 * (manifest), y esta es la ultima defensa si ese cast fuera incorrecto.
 */
const assertArtifactLineage = (
  lineage: Omit<AiModelArtifactLineage, 'artifactPurpose'> & { readonly artifactPurpose: string },
): AiModelArtifactLineage => {
  assertSha256Hex(lineage.modelStateSha256, 'modelStateSha256')
  assertSha256Hex(lineage.onnxArtifactSha256, 'onnxArtifactSha256')
  assertSha256Hex(lineage.pytorchArtifactSha256, 'pytorchArtifactSha256')
  assertSha256Hex(lineage.metricsFileSha256, 'metricsFileSha256')
  if (lineage.artifactPurpose !== 'SMOKE_TEST' && lineage.artifactPurpose !== 'CANDIDATE') {
    throw new TypeError(
      `"artifactPurpose" = "${lineage.artifactPurpose}" no es un valor reconocido.`,
    )
  }
  return { ...lineage, artifactPurpose: lineage.artifactPurpose }
}

export class AiModelVersion {
  private constructor(private readonly props: AiModelVersionProps) {}

  /** Crea la version en `TRAINING` (#570 §9, §53): revision 0, sin artifact lineage todavia. */
  static startTraining(trainingLineage: AiModelTrainingLineage, at: Date): AiModelVersion {
    const lineage = assertTrainingLineage(trainingLineage)
    return new AiModelVersion({
      trainingLineage: lineage,
      artifactLineage: null,
      state: AiModelState.Training,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      stateHistory: [{ from: null, to: AiModelState.Training, at }],
      rejection: null,
    })
  }

  /** Reconstruccion desde persistencia (#570 §90): nunca revalida invariantes ya garantizadas al escribir. */
  static restore(props: AiModelVersionProps): AiModelVersion {
    return new AiModelVersion(props)
  }

  get modelVersion(): string {
    return this.props.trainingLineage.modelVersion
  }

  get state(): AiModelStateType {
    return this.props.state
  }

  get revision(): number {
    return this.props.revision
  }

  get trainingLineage(): AiModelTrainingLineage {
    return this.props.trainingLineage
  }

  get artifactLineage(): AiModelArtifactLineage | null {
    return this.props.artifactLineage
  }

  get stateHistory(): readonly AiModelStateHistoryEntry[] {
    return this.props.stateHistory
  }

  get rejection(): AiModelRejection | null {
    return this.props.rejection
  }

  get createdAt(): Date {
    return this.props.createdAt
  }

  get updatedAt(): Date {
    return this.props.updatedAt
  }

  /** Para persistencia (#570 §90-91): expone exactamente el estado interno, sin copias defensivas extra. */
  toProps(): AiModelVersionProps {
    return this.props
  }

  private transitionTo(
    to: AiModelStateType,
    at: Date,
    overrides: Partial<Pick<AiModelVersionProps, 'artifactLineage' | 'rejection'>> = {},
  ): AiModelVersion {
    if (!isAllowedAiModelStateTransition(this.props.state, to)) {
      throw new InvalidModelStateTransitionError(this.props.state, to)
    }
    return new AiModelVersion({
      ...this.props,
      ...overrides,
      state: to,
      revision: this.props.revision + 1,
      updatedAt: at,
      stateHistory: [...this.props.stateHistory, { from: this.props.state, to, at }],
    })
  }

  /**
   * `TRAINING -> CANDIDATE` (#570 §53): liga el artifact lineage (hashes
   * YA validados por el caller -- esta entidad no recalcula SHA-256, eso
   * es responsabilidad de infraestructura/aplicacion) de forma inmutable.
   * Nunca permite re-ligar un artifact lineage distinto despues: una vez
   * en `CANDIDATE`, `artifactLineage` no vuelve a cambiar.
   */
  registerCandidate(artifactLineage: AiModelArtifactLineage, at: Date): AiModelVersion {
    const validated = assertArtifactLineage(artifactLineage)
    return this.transitionTo(AiModelState.Candidate, at, { artifactLineage: validated })
  }

  /** `CANDIDATE -> EVALUATING` (#570 §53-55): primitiva de transicion, sin logica de gates. */
  beginEvaluation(at: Date): AiModelVersion {
    return this.transitionTo(AiModelState.Evaluating, at)
  }

  /**
   * `EVALUATING -> ACTIVE` (#570 §14, §55): la PRIMITIVA SEGURA, nunca la
   * decision de activar. Defensa en profundidad incluso si el caller (una
   * futura `#572`) se equivocara: jamas permite activar sin artifact
   * lineage, ni un `artifactPurpose=SMOKE_TEST` (#570 §19, §37, §88) --
   * esto NO es un gate de calidad, es una invariante de integridad.
   */
  activate(at: Date): AiModelVersion {
    if (!isAllowedAiModelStateTransition(this.props.state, AiModelState.Active)) {
      throw new InvalidModelStateTransitionError(this.props.state, AiModelState.Active)
    }
    if (this.props.artifactLineage === null) {
      throw new ModelSchemaIncompatibleError(
        'no se puede activar sin artifact lineage (CANDIDATE).',
      )
    }
    if (this.props.artifactLineage.artifactPurpose !== 'CANDIDATE') {
      throw new ModelSchemaIncompatibleError(
        `artifactPurpose="${this.props.artifactLineage.artifactPurpose}" nunca puede llegar a ACTIVE.`,
      )
    }
    return this.transitionTo(AiModelState.Active, at)
  }

  /** Cualquier transicion permitida hacia `REJECTED` (#570 §13, §57-58). */
  reject(reasonCode: AiModelRejectionReasonCode, reason: string, at: Date): AiModelVersion {
    return this.transitionTo(AiModelState.Rejected, at, {
      rejection: { reasonCode, reason, rejectedAt: at },
    })
  }
}
