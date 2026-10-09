import { createHash } from 'node:crypto'
import {
  AiModelVersion,
  type AiModelArtifactPurpose,
  type AiModelRejectionReasonCode,
  type AiModelTrainingLineage,
} from '../../domain/entities/AiModelVersion'
import { AiModelState } from '../../domain/value-objects/AiModelState'
import {
  ActiveModelConflictError,
  InvalidModelStateTransitionError,
  ModelArtifactHashMismatchError,
  ModelArtifactNotFoundError,
  ModelSchemaIncompatibleError,
  ModelTrainingLineageMismatchError,
  ModelVersionConflictError,
} from '../../domain/errors/AiModelRegistryErrors'
import type { ClockPort } from '../ports/ClockPort'
import type { AiModelArtifactRepositoryPort } from '../ports/AiModelArtifactRepositoryPort'
import type { AiModelRegistryRepositoryPort } from '../ports/AiModelRegistryRepositoryPort'

const sha256HexOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Subconjunto del manifest que `registerCandidate` necesita (#570 §9,
 * §53-54): deliberadamente NO importa `AiModelTrainingManifestV1` de
 * `infrastructure/ai` (la capa de aplicacion solo depende de puertos y
 * dominio, ver regla `no-restricted-imports`) -- el caller (infraestructura)
 * ya parseo/valido el manifest completo con `parseAndValidateModelTrainingManifest`
 * y pasa aqui los campos que la union estructural de TypeScript ya
 * satisface sin mapeo explicito.
 *
 * Incluye los campos de `AiModelTrainingLineage` (revision de codigo,
 * #570): `registerCandidate` los compara contra `current.trainingLineage`
 * para demostrar que el manifest pertenece REALMENTE al training
 * registrado -- nunca solo que los hashes de ONNX/metricas coinciden.
 */
export interface CandidateArtifactManifest {
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
  /** Opaco (revision de codigo, #570): nunca interpretado salvo para extraer `trainingSeed`. */
  readonly trainingConfig: Readonly<Record<string, unknown>>
  readonly datasetCounts: Readonly<Record<string, unknown>>
  readonly modelStateSha256: string
  readonly onnxArtifactSha256: string
  readonly pytorchArtifactSha256: string
  readonly metricsFileSha256: string
  readonly parityReferenceSha256: string
  readonly artifactPurpose: string
}

export interface RegisterCandidateParams {
  readonly modelVersion: string
  /** YA parseado/validado contra el contrato de runtime (#567/#568) por el caller. */
  readonly manifest: CandidateArtifactManifest
  /** Bytes REALES de `training-manifest.json` (revision #570): su SHA-256 se persiste como `trainingManifestSha256`. */
  readonly manifestBytes: Buffer
  readonly onnxBytes: Buffer
  readonly metricsBytes: Buffer
  /**
   * Bytes REALES de `pytorch-parity-reference.json` (EN-037.3, Management
   * #572 §6), generados por la herramienta YA existente
   * `nexus-combat-parity-reference` (#569) ANTES de que #571 borre el work
   * dir. Sin esto, el gate de paridad de `#572` nunca tendria una
   * referencia PyTorch durable que comparar contra el ONNX.
   */
  readonly parityReferenceBytes: Buffer
}

/** `trainingConfig.trainingSeed` (revision #570): distinto de `datasetSeed`, nunca asumido igual. */
const requireTrainingSeed = (trainingConfig: Readonly<Record<string, unknown>>): number => {
  const value = trainingConfig.trainingSeed
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ModelTrainingLineageMismatchError(
      'trainingConfig.trainingSeed',
      'number',
      typeof value,
    )
  }
  return value
}

/**
 * Comprueba fail-closed que el manifest recibido pertenece REALMENTE al
 * training registrado en `current.trainingLineage` (revision de codigo,
 * #570): sin esto, un artifact lineage del training B podria ligarse al
 * training lineage de una version A con solo tener bytes de ONNX/metricas
 * que coincidan con SUS PROPIOS hashes declarados.
 */
const assertManifestMatchesTrainingLineage = (
  lineage: AiModelTrainingLineage,
  manifest: CandidateArtifactManifest,
): void => {
  const trainingSeed = requireTrainingSeed(manifest.trainingConfig)
  const checks: readonly (readonly [string, unknown, unknown])[] = [
    [
      'modelArchitectureVersion',
      lineage.modelArchitectureVersion,
      manifest.modelArchitectureVersion,
    ],
    ['featureSchemaVersion', lineage.featureSchemaVersion, manifest.featureSchemaVersion],
    ['teacherVersion', lineage.teacherVersion, manifest.teacherVersion],
    ['utilityVersion', lineage.utilityVersion, manifest.utilityVersion],
    ['trainingSourceCommit', lineage.trainingSourceCommit, manifest.trainingSourceCommit],
    ['datasetSourceCommit', lineage.datasetSourceCommit, manifest.datasetSourceCommit],
    ['datasetInputFingerprint', lineage.datasetInputFingerprint, manifest.datasetInputFingerprint],
    [
      'datasetOutputFingerprint',
      lineage.datasetOutputFingerprint,
      manifest.datasetOutputFingerprint,
    ],
    ['datasetCutoff', lineage.datasetCutoff, manifest.datasetCutoff],
    ['datasetSeed', lineage.datasetSeed, manifest.datasetSeed],
    ['trainingConfigSha256', lineage.trainingConfigSha256, manifest.trainingConfigSha256],
    ['trainingSeed', lineage.trainingSeed, trainingSeed],
  ]
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) throw new ModelTrainingLineageMismatchError(field, expected, actual)
  }
}

/** `metrics.json` ya no se descarta tras hashearlo (revision #570): se parsea y persiste para reproducibilidad real. */
const parseOpaqueJsonObject = (bytes: Buffer, label: string): Readonly<Record<string, unknown>> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ModelSchemaIncompatibleError(`"${label}" no es JSON valido.`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelSchemaIncompatibleError(`"${label}" debe ser un objeto JSON.`)
  }
  return parsed as Readonly<Record<string, unknown>>
}

/**
 * Servicio de aplicacion del model registry (EN-037.1, Management #570
 * §48): responsable de crear training versions, registrar candidates,
 * iniciar evaluacion, activar, rechazar, validar transiciones/integridad
 * y consultar el ACTIVE. El repository NUNCA contiene esta logica de
 * negocio (#570 §48) -- solo persiste lo que este servicio ya valido.
 *
 * El registry NO sabe que es un buen modelo (#570 §14, §59, §136): nunca
 * referencia `RandomPolicy`/`RuleBasedPolicy`/MCTS/winRate/
 * `EvaluationScenario`/el harness de `#569`. `activate()` es la
 * PRIMITIVA segura; decidir CUANDO llamarla es `#572`.
 */
export class AiModelRegistry {
  constructor(
    private readonly registryRepository: AiModelRegistryRepositoryPort,
    private readonly artifactRepository: AiModelArtifactRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  /** `TRAINING` (#570 §9, §17): `trainingLineage.modelVersion`/`trainingRunId` ya vienen derivados por el caller. */
  async startTraining(trainingLineage: AiModelTrainingLineage): Promise<AiModelVersion> {
    const version = AiModelVersion.startTraining(trainingLineage, this.clock.now())
    await this.registryRepository.insertNew(version)
    return version
  }

  /**
   * `TRAINING -> CANDIDATE` (#570 §53-54): recalcula el SHA-256 REAL de
   * `onnxBytes`/`metricsBytes`/`manifestBytes` (nunca confia en el valor
   * declarado del manifest sin comprobarlo), comprueba fail-closed que el
   * manifest pertenece REALMENTE al training registrado
   * (`assertManifestMatchesTrainingLineage`, revision de codigo #570 --
   * antes solo se comprobaban los hashes de artefacto, nunca que el
   * manifest fuera del training correcto), y persiste el artifact ONNX de
   * forma content-addressed ANTES del cambio de estado -- si la
   * transicion fallara despues, un artifact huerfano content-addressed no
   * corrompe nada y es reutilizable (#570 §54).
   *
   * Exige `artifactPurpose=CANDIDATE` (revision de codigo, #570): un
   * `SMOKE_TEST` NUNCA entra al ciclo de vida productivo, ni siquiera como
   * CANDIDATE/EVALUATING -- `assertArtifactLineage` (dominio) lo rechaza.
   * El artifact store de un `SMOKE_TEST` real se prueba directamente
   * contra `AiModelArtifactRepositoryPort`, sin pasar por el registry.
   */
  async registerCandidate(params: RegisterCandidateParams): Promise<AiModelVersion> {
    const current = await this.requireByVersion(params.modelVersion)

    const actualOnnxSha256 = sha256HexOf(params.onnxBytes)
    if (actualOnnxSha256 !== params.manifest.onnxArtifactSha256) {
      throw new ModelArtifactHashMismatchError(params.manifest.onnxArtifactSha256, actualOnnxSha256)
    }

    const actualMetricsSha256 = sha256HexOf(params.metricsBytes)
    if (actualMetricsSha256 !== params.manifest.metricsFileSha256) {
      throw new ModelArtifactHashMismatchError(
        params.manifest.metricsFileSha256,
        actualMetricsSha256,
      )
    }

    const actualParityReferenceSha256 = sha256HexOf(params.parityReferenceBytes)
    if (actualParityReferenceSha256 !== params.manifest.parityReferenceSha256) {
      throw new ModelArtifactHashMismatchError(
        params.manifest.parityReferenceSha256,
        actualParityReferenceSha256,
      )
    }

    assertManifestMatchesTrainingLineage(current.trainingLineage, params.manifest)

    const metrics = parseOpaqueJsonObject(params.metricsBytes, 'metrics.json')
    const trainingManifestSha256 = sha256HexOf(params.manifestBytes)

    const at = this.clock.now()
    await this.artifactRepository.put(actualOnnxSha256, params.onnxBytes, at, 'ONNX_MODEL')
    await this.artifactRepository.put(
      actualParityReferenceSha256,
      params.parityReferenceBytes,
      at,
      'PARITY_REFERENCE',
    )

    const next = current.registerCandidate(
      {
        modelStateSha256: params.manifest.modelStateSha256,
        onnxArtifactSha256: actualOnnxSha256,
        pytorchArtifactSha256: params.manifest.pytorchArtifactSha256,
        metricsFileSha256: actualMetricsSha256,
        parityReferenceSha256: actualParityReferenceSha256,
        artifactPurpose: params.manifest.artifactPurpose as AiModelArtifactPurpose,
        trainingManifestSha256,
        trainingConfig: params.manifest.trainingConfig,
        datasetCounts: params.manifest.datasetCounts,
        metrics,
      },
      at,
    )
    await this.registryRepository.replaceWithExpectedRevision(next, current.revision)
    return next
  }

  /** `CANDIDATE -> EVALUATING` (#570 §53, §55): primitiva, sin logica de gates. */
  async beginEvaluation(modelVersion: string): Promise<AiModelVersion> {
    const current = await this.requireByVersion(modelVersion)
    const next = current.beginEvaluation(this.clock.now())
    await this.registryRepository.replaceWithExpectedRevision(next, current.revision)
    return next
  }

  /**
   * `EVALUATING -> ACTIVE` (#570 §14-15, §34, §55): vuelve a comprobar
   * integridad en lectura (#570 §34: "no asumir que Mongo jamas puede
   * contener datos corruptos/manipulados") -- el artefacto debe existir
   * en el store Y su SHA-256 real debe coincidir con el lineage, ADEMAS
   * de las invariantes que ya aplica `AiModelVersion.activate()`
   * (artifact lineage presente, `artifactPurpose=CANDIDATE`). Nunca
   * ejecuta gates de gameplay: eso es `#572`.
   */
  async activate(modelVersion: string): Promise<AiModelVersion> {
    const current = await this.requireByVersion(modelVersion)
    await this.assertArtifactIntegrity(current)

    const next = current.activate(this.clock.now())
    const reference = await this.registryRepository.getActiveReference()
    if (reference === null) {
      const swapped = await this.registryRepository.compareAndSwapActiveReference(
        null,
        { modelVersion, modelRevision: next.revision },
        this.clock.now(),
      )
      if (swapped === null) throw new ActiveModelConflictError()
    } else if (reference.modelVersion !== modelVersion) {
      throw new ActiveModelConflictError()
    }
    await this.registryRepository.replaceWithExpectedRevision(next, current.revision)
    return next
  }

  /**
   * `ACTIVE -> SUPERSEDED` (EN-037.3, Management #572 §8): reconcilia el
   * historial despues de mover la referencia ACTIVE autoritativa. PRIMITIVA, nunca decide CUANDO reemplazar el ACTIVE
   * vigente -- solo `promoteEvaluatedCandidate`/`rollbackToSuperseded`
   * (dentro de este mismo registry) la invocan. Idempotente: si la
   * version ya esta SUPERSEDED (reintento tras una caida a mitad de
   * promocion), es un no-op.
   */
  async supersedeActive(modelVersion: string): Promise<AiModelVersion> {
    const current = await this.requireByVersion(modelVersion)
    if (current.state === AiModelState.Superseded) return current
    const next = current.supersede(this.clock.now())
    await this.registryRepository.replaceWithExpectedRevision(next, current.revision)
    return next
  }

  /**
   * Reemplazo seguro del ACTIVE vigente (EN-037.3, Management #572 §8):
   * recibe un candidato que YA paso por `EVALUATING` y YA fue aprobado
   * por `PromotionPolicyV1` en la capa de aplicacion de `#572` -- esta
   * primitiva NUNCA evalua gates ni win rate, solo ejecuta el reemplazo
   * de forma segura y recuperable.
   *
   * Mongo standalone no ofrece transaccion multi-documento, por eso la
   * autoridad de runtime es UN documento `ai-model-active-reference`.
   * Su CAS cambia anterior->candidato atomicamente y exige version,
   * revision y generation esperadas. Los estados historicos se
   * reconcilian despues; nunca existe una ventana sin referencia ACTIVE.
   */
  async promoteEvaluatedCandidate(
    candidateVersion: string,
    expectedActive?: { readonly modelVersion: string; readonly revision: number } | null,
  ): Promise<AiModelVersion> {
    const candidate = await this.requireByVersion(candidateVersion)

    const currentReference = await this.registryRepository.getActiveReference()
    if (currentReference?.modelVersion === candidateVersion) {
      return this.reconcileAuthoritativeActive(candidate, expectedActive ?? null)
    }

    if (candidate.state !== AiModelState.Evaluating) {
      throw new InvalidModelStateTransitionError(candidate.state, AiModelState.Active)
    }

    // Preflight ANTES del CAS. Un candidato ausente o corrupto nunca puede
    // convertirse en referencia autoritativa.
    await this.assertArtifactIntegrity(candidate)

    const resolvedExpected =
      expectedActive === undefined
        ? currentReference === null
          ? null
          : {
              modelVersion: currentReference.modelVersion,
              revision: currentReference.modelRevision,
            }
        : expectedActive
    const matchesExpected =
      resolvedExpected === null
        ? currentReference === null
        : currentReference !== null &&
          currentReference.modelVersion === resolvedExpected.modelVersion &&
          currentReference.modelRevision === resolvedExpected.revision
    if (!matchesExpected) throw new ActiveModelConflictError()

    const next = candidate.activate(this.clock.now())
    const swapped = await this.registryRepository.compareAndSwapActiveReference(
      currentReference,
      { modelVersion: candidateVersion, modelRevision: next.revision },
      this.clock.now(),
    )
    if (swapped === null) throw new ActiveModelConflictError()

    try {
      if (resolvedExpected !== null && resolvedExpected.modelVersion !== candidateVersion) {
        await this.supersedeActive(resolvedExpected.modelVersion)
      }
      await this.registryRepository.replaceWithExpectedRevision(next, candidate.revision)
      return next
    } catch (error) {
      await this.compensateAtomicSelection(swapped, resolvedExpected)
      throw error
    }
  }

  /**
   * Rollback explicito (EN-037.3, Management #572 §10): reactiva una
   * version PREVIAMENTE ACTIVE (ahora `SUPERSEDED`) -- nunca acepta como
   * destino una version `REJECTED` (el grafo de transiciones de
   * `AiModelState` ya lo impide estructuralmente, nunca solo por
   * convencion) ni un artefacto corrupto (reutiliza la MISMA
   * reverificacion de hash real que `activate()`, nunca una comprobacion
   * nueva y distinta). Usa el mismo CAS autoritativo que la promocion.
   */
  async rollbackToSuperseded(targetVersion: string): Promise<AiModelVersion> {
    const target = await this.requireByVersion(targetVersion)

    if (target.state === AiModelState.Active) return target

    if (target.state !== AiModelState.Superseded) {
      throw new InvalidModelStateTransitionError(target.state, AiModelState.Active)
    }

    await this.assertArtifactIntegrity(target)

    const currentReference = await this.registryRepository.getActiveReference()
    const next = target.activate(this.clock.now())
    const swapped = await this.registryRepository.compareAndSwapActiveReference(
      currentReference,
      { modelVersion: targetVersion, modelRevision: next.revision },
      this.clock.now(),
    )
    if (swapped === null) throw new ActiveModelConflictError()
    if (currentReference !== null && currentReference.modelVersion !== targetVersion) {
      await this.supersedeActive(currentReference.modelVersion)
    }
    await this.registryRepository.replaceWithExpectedRevision(next, target.revision)
    return next
  }

  /** Cualquier transicion valida hacia `REJECTED` (#570 §13, §57-58). */
  async reject(
    modelVersion: string,
    reasonCode: AiModelRejectionReasonCode,
    reason: string,
  ): Promise<AiModelVersion> {
    const current = await this.requireByVersion(modelVersion)
    const next = current.reject(reasonCode, reason, this.clock.now())
    await this.registryRepository.replaceWithExpectedRevision(next, current.revision)
    return next
  }

  async findActive(): Promise<AiModelVersion | null> {
    return this.registryRepository.findActive()
  }

  async findByVersion(modelVersion: string): Promise<AiModelVersion | null> {
    return this.registryRepository.findByVersion(modelVersion)
  }

  async findByTrainingRunId(trainingRunId: string): Promise<AiModelVersion | null> {
    return this.registryRepository.findByTrainingRunId(trainingRunId)
  }

  /** Descubrimiento de trabajo pendiente (#572 §7.1): `listByState('CANDIDATE')` para el `AutomaticModelEvaluationCoordinator`, sin inventar una cola externa. */
  async listByState(state: AiModelState): Promise<readonly AiModelVersion[]> {
    return this.registryRepository.listByState(state)
  }

  private async requireByVersion(modelVersion: string): Promise<AiModelVersion> {
    const found = await this.registryRepository.findByVersion(modelVersion)
    if (found === null) {
      throw new ModelVersionConflictError(`no existe ninguna version "${modelVersion}".`)
    }
    return found
  }

  private async assertArtifactIntegrity(model: AiModelVersion): Promise<void> {
    if (model.artifactLineage === null) return

    const expectedHash = model.artifactLineage.onnxArtifactSha256
    const artifact = await this.artifactRepository.getBySha256(expectedHash)
    if (artifact === null) throw new ModelArtifactNotFoundError(expectedHash)

    const actualHash = sha256HexOf(artifact.bytes)
    if (actualHash !== expectedHash) {
      throw new ModelArtifactHashMismatchError(expectedHash, actualHash)
    }
  }

  private async reconcileAuthoritativeActive(
    candidate: AiModelVersion,
    previous: { readonly modelVersion: string; readonly revision: number } | null,
  ): Promise<AiModelVersion> {
    if (candidate.state === AiModelState.Active) return candidate
    if (candidate.state !== AiModelState.Evaluating) {
      throw new InvalidModelStateTransitionError(candidate.state, AiModelState.Active)
    }
    if (previous !== null && previous.modelVersion !== candidate.modelVersion) {
      const old = await this.registryRepository.findByVersion(previous.modelVersion)
      if (old?.state === AiModelState.Active) await this.supersedeActive(old.modelVersion)
    }
    const next = candidate.activate(this.clock.now())
    await this.registryRepository.replaceWithExpectedRevision(next, candidate.revision)
    return next
  }

  /** Revierte el puntero solo si nadie lo movio desde nuestro CAS (generation=fencing). */
  private async compensateAtomicSelection(
    attempted: {
      readonly modelVersion: string
      readonly modelRevision: number
      readonly generation: number
    },
    previous: { readonly modelVersion: string; readonly revision: number } | null,
  ): Promise<void> {
    if (previous === null) return
    try {
      const storedPrevious = await this.requireByVersion(previous.modelVersion)
      const restored =
        storedPrevious.state === AiModelState.Superseded
          ? storedPrevious.activate(this.clock.now())
          : storedPrevious
      const swapped = await this.registryRepository.compareAndSwapActiveReference(
        attempted,
        { modelVersion: restored.modelVersion, modelRevision: restored.revision },
        this.clock.now(),
      )
      if (swapped !== null && restored !== storedPrevious) {
        await this.registryRepository.replaceWithExpectedRevision(restored, storedPrevious.revision)
      }
    } catch {
      // Preserva el error original; el fencing impide pisar una seleccion mas reciente.
    }
  }
}
