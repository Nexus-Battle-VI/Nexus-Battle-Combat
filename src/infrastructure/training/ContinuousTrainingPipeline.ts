import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClockPort } from '../../application/ports/ClockPort'
import type { BattleRoomRepositoryPort } from '../../application/ports/BattleRoomRepositoryPort'
import type {
  ContinuousTrainingCoordinatorPort,
  ContinuousTrainingFailureReasonCode,
} from '../../application/ports/ContinuousTrainingCoordinatorPort'
import type { AiModelRegistry } from '../../application/services/AiModelRegistry'
import type { AiModelTrainingLineage } from '../../domain/entities/AiModelVersion'
import { parseAndValidateModelTrainingManifest } from '../ai/AiModelTrainingManifestV1'
import { isDatasetTrainable, parseAndValidateDatasetManifest } from '../ai/DatasetManifestV1'
import { NEURAL_MODEL_ARCHITECTURE_VERSION } from '../ai/NeuralTrainingManifestV1'
import {
  ChildProcessExitError,
  type ChildProcessOptions,
  type ChildProcessRunner,
  type RunningChildProcess,
} from './ChildProcessRunner'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Nucleo de UNA iteracion del worker de reentrenamiento continuo
 * (EN-037.2, Management #571). Separado del CLI (`continuous-training-worker.ts`)
 * para que sea comprobable con un `ChildProcessRunner` falso, sin spawnear
 * Python real en cada prueba unitaria.
 *
 * Decision deliberada (#571 §8.3, documentada en
 * `docs/en-037-continuous-training-worker.md`): este worker NUNCA llama
 * `registry.reject(...)` automaticamente ante un fallo de training. Un
 * `trainingRunId` es determinista (mismo dataset+config+seed -> mismo id);
 * si se rechazara automaticamente tras un fallo que pudiera ser transitorio,
 * un reintento exitoso mas tarde con los MISMOS insumos chocaria contra la
 * transicion prohibida `REJECTED -> CANDIDATE`, bloqueando ese identificador
 * para siempre. Se prefiere dejar la version abandonada en `TRAINING`
 * (observable, nunca bloqueante) a arriesgar un bloqueo permanente por un
 * fallo que resulto ser transitorio.
 */

export interface ContinuousTrainingPipelineDeps {
  readonly battleRooms: BattleRoomRepositoryPort
  readonly coordinator: ContinuousTrainingCoordinatorPort
  readonly registry: AiModelRegistry
  readonly clock: ClockPort
  readonly logger: Logger
  readonly runChildProcess: ChildProcessRunner
}

export interface ContinuousTrainingPipelineConfig {
  readonly ownerId: string
  readonly aiDir: string
  readonly pythonCommand: string
  readonly mongoUri: string
  /** Pasada EXPLICITAMENTE a `--database` en `nexus-combat-dataset build` (#571): el CLI Python nunca adivina el nombre a partir de la URI. */
  readonly databaseName: string
  readonly datasetSeed: number
  readonly trainingSeed: number
  readonly sourceCommit: string
  readonly gracePeriodMs: number
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly datasetBuildTimeoutMs: number
  readonly trainingTimeoutMs: number
  readonly identityTimeoutMs: number
  readonly workRootDir: string
  /**
   * Cuantas veces reintentar el MISMO cutoff tras `NOT_TRAINABLE` antes de
   * darlo por definitivo y avanzar `processedThrough` (revision de
   * codigo, #571 §7.3): un dataset insuficiente puede resolverse solo
   * (labels todavia en vuelo) sin que llegue ninguna partida nueva.
   */
  readonly maxNotTrainableRetries: number
  /**
   * Pasa `--allow-missing-labels` a `nexus-combat-dataset build`. Por defecto
   * (ausente o `false`) el dataset falla cerrado si hay decisiones
   * ONLINE/TOURNAMENT sin `MctsTeacherLabel`. Solo se activa explicitamente
   * para un hueco CONOCIDO: el historial anterior a activar
   * `MCTS_LIVE_TEACHER_LABELING_ENABLED` nunca podra etiquetarse (el evento no
   * guarda la sala completa, ver `docs/en-036-mcts-teacher.md`), asi que sin
   * esta opcion esas decisiones bloquearian cada build para siempre. Las
   * decisiones sin etiqueta se OMITEN del dataset; nunca se inventan.
   */
  readonly allowMissingLabels?: boolean
}

export type ContinuousTrainingIterationOutcome =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'LEASE_BUSY' }
  | { readonly kind: 'SUCCESS'; readonly modelVersion: string }
  | { readonly kind: 'NOT_TRAINABLE'; readonly reason: string }
  | {
      readonly kind: 'FAILED'
      readonly reasonCode: ContinuousTrainingFailureReasonCode
      readonly reason: string
    }

export interface ContinuousTrainingIterationResult {
  readonly outcome: ContinuousTrainingIterationOutcome
  /** Proximo limite inferior para `findFinishedSince` (#571 §5.1): nunca retrocede. */
  readonly nextScanWatermark: Date
}

class ClassifiedPipelineError extends Error {
  constructor(
    readonly reasonCode: ContinuousTrainingFailureReasonCode,
    message: string,
  ) {
    super(message)
    this.name = 'ClassifiedPipelineError'
  }
}

const maxDate = (dates: readonly Date[]): Date =>
  dates.reduce((max, current) => (current.getTime() > max.getTime() ? current : max))

const minDate = (a: Date, b: Date): Date => (a.getTime() < b.getTime() ? a : b)

/**
 * Avanza `requestedThrough` con el mismo criterio de "periodo de gracia"
 * en CADA tick, independientemente de lo que se haya encontrado (#571
 * §5.2): nada queda permanentemente excluido por llegar tarde, porque el
 * limite de escaneo del PROXIMO tick es siempre el limite de gracia de
 * ESTE tick, nunca mas alla.
 */
const advanceRequestedThrough = async (
  deps: ContinuousTrainingPipelineDeps,
  config: ContinuousTrainingPipelineConfig,
  scanWatermark: Date,
  now: Date,
): Promise<Date> => {
  const graceSafeNow = new Date(now.getTime() - config.gracePeriodMs)
  const recentlyFinished = await deps.battleRooms.findFinishedSince(scanWatermark)

  const eligibleFinishedAts = recentlyFinished
    .map((room) => room.result?.finishedAt)
    .filter((iso): iso is string => iso !== undefined)
    .map((iso) => new Date(iso))
    .filter((finishedAt) => finishedAt.getTime() <= graceSafeNow.getTime())

  if (eligibleFinishedAts.length > 0) {
    await deps.coordinator.advanceRequestedThrough(maxDate(eligibleFinishedAts), now)
    deps.logger.info('continuous_training_requested_through_advanced', {
      eligibleBattles: eligibleFinishedAts.length,
      graceSafeNow: graceSafeNow.toISOString(),
    })
  }

  return graceSafeNow
}

const pythonArgs = (args: readonly string[]): readonly string[] => ['run', ...args]

/**
 * Como `runToCompletionOrThrow` (`ChildProcessRunner.ts`), pero ademas
 * expone el `RunningChildProcess` en marcha via `trackRunning` (#571
 * §6.2, CT-12): el heartbeat del lease necesita un handle cancelable
 * mientras el subproceso corre, no solo su resultado final.
 */
const runTrackedToCompletion = async (
  runner: ChildProcessRunner,
  command: string,
  args: readonly string[],
  options: ChildProcessOptions,
  trackRunning: (running: RunningChildProcess | null) => void,
): Promise<{ readonly stdout: string }> => {
  const running = runner(command, args, options)
  trackRunning(running)
  try {
    const outcome = await running.result
    if (outcome.exitCode !== 0) {
      throw new ChildProcessExitError(command, outcome.exitCode, outcome.stderr)
    }
    return { stdout: outcome.stdout }
  } finally {
    trackRunning(null)
  }
}

const buildDataset = async (
  deps: ContinuousTrainingPipelineDeps,
  config: ContinuousTrainingPipelineConfig,
  datasetDir: string,
  cutoff: Date,
  trackRunning: (running: RunningChildProcess | null) => void,
): Promise<void> => {
  try {
    await runTrackedToCompletion(
      deps.runChildProcess,
      config.pythonCommand,
      pythonArgs([
        'nexus-combat-dataset',
        'build',
        '--source',
        'mongo',
        '--database',
        config.databaseName,
        '--output',
        datasetDir,
        '--cutoff',
        cutoff.toISOString(),
        '--source-commit',
        config.sourceCommit,
        '--seed',
        String(config.datasetSeed),
        ...(config.allowMissingLabels === true ? ['--allow-missing-labels'] : []),
      ]),
      {
        cwd: config.aiDir,
        env: { ...process.env, MONGODB_URI: config.mongoUri },
        timeoutMs: config.datasetBuildTimeoutMs,
      },
      trackRunning,
    )
  } catch (error) {
    throw new ClassifiedPipelineError(
      'DATASET_BUILD_FAILED',
      `nexus-combat-dataset build fallo: ${describeError(error)}`,
    )
  }
}

const emitTrainingIdentity = async (
  deps: ContinuousTrainingPipelineDeps,
  config: ContinuousTrainingPipelineConfig,
  datasetDir: string,
  trackRunning: (running: RunningChildProcess | null) => void,
): Promise<{ runId: string; trainingConfigSha256: string; datasetOutputFingerprint: string }> => {
  let stdout: string
  try {
    const outcome = await runTrackedToCompletion(
      deps.runChildProcess,
      config.pythonCommand,
      pythonArgs([
        'nexus-combat-train',
        '--dataset-dir',
        datasetDir,
        '--output',
        join(datasetDir, '..', 'unused-identity-only-output'),
        '--source-commit',
        config.sourceCommit,
        '--seed',
        String(config.trainingSeed),
        '--emit-identity-only',
      ]),
      { cwd: config.aiDir, env: process.env, timeoutMs: config.identityTimeoutMs },
      trackRunning,
    )
    stdout = outcome.stdout
  } catch (error) {
    throw new ClassifiedPipelineError(
      'TRAINING_PROCESS_FAILED',
      `nexus-combat-train --emit-identity-only fallo: ${describeError(error)}`,
    )
  }

  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
    const runId = parsed.runId
    const trainingConfigSha256 = parsed.trainingConfigSha256
    const datasetOutputFingerprint = parsed.datasetOutputFingerprint
    if (
      typeof runId !== 'string' ||
      typeof trainingConfigSha256 !== 'string' ||
      typeof datasetOutputFingerprint !== 'string'
    ) {
      throw new Error('forma inesperada en la salida de --emit-identity-only.')
    }
    return { runId, trainingConfigSha256, datasetOutputFingerprint }
  } catch (error) {
    throw new ClassifiedPipelineError(
      'TRAINING_PROCESS_FAILED',
      `No se pudo parsear la identidad emitida por --emit-identity-only: ${describeError(error)}`,
    )
  }
}

const runTraining = async (
  deps: ContinuousTrainingPipelineDeps,
  config: ContinuousTrainingPipelineConfig,
  datasetDir: string,
  artifactsDir: string,
  trackRunning: (running: RunningChildProcess | null) => void,
): Promise<void> => {
  try {
    await runTrackedToCompletion(
      deps.runChildProcess,
      config.pythonCommand,
      pythonArgs([
        'nexus-combat-train',
        '--dataset-dir',
        datasetDir,
        '--output',
        artifactsDir,
        '--source-commit',
        config.sourceCommit,
        '--seed',
        String(config.trainingSeed),
        '--artifact-purpose',
        'CANDIDATE',
      ]),
      { cwd: config.aiDir, env: process.env, timeoutMs: config.trainingTimeoutMs },
      trackRunning,
    )
  } catch (error) {
    throw new ClassifiedPipelineError(
      'TRAINING_PROCESS_FAILED',
      `nexus-combat-train fallo: ${describeError(error)}`,
    )
  }
}

/**
 * Genera `pytorch-parity-reference.json` (EN-037.3, Management #572 §6)
 * invocando la herramienta YA existente `nexus-combat-parity-reference`
 * (#569, `ai/src/nexus_combat_ai/cli/parity_reference.py`) sobre el
 * `model.pt`/`training-manifest.json` REALES que `runTraining` acaba de
 * producir en `runDir` -- esta pipeline NUNCA reimplementa el calculo de
 * paridad, solo invoca la CLI Python que ya lo hace y persiste su salida
 * ANTES de que el `finally` de `runContinuousTrainingIteration` borre
 * `workDir` (y con el, `model.pt`, nunca persistido en otro lugar).
 */
const generateParityReference = async (
  deps: ContinuousTrainingPipelineDeps,
  config: ContinuousTrainingPipelineConfig,
  runDir: string,
  trackRunning: (running: RunningChildProcess | null) => void,
): Promise<Buffer> => {
  const outputPath = join(runDir, 'pytorch-parity-reference.json')
  try {
    await runTrackedToCompletion(
      deps.runChildProcess,
      config.pythonCommand,
      pythonArgs([
        'nexus-combat-parity-reference',
        '--artifact-dir',
        runDir,
        '--output',
        outputPath,
      ]),
      { cwd: config.aiDir, env: process.env, timeoutMs: config.identityTimeoutMs },
      trackRunning,
    )
  } catch (error) {
    throw new ClassifiedPipelineError(
      'ARTIFACT_INVALID',
      `nexus-combat-parity-reference fallo: ${describeError(error)}`,
    )
  }

  try {
    return await readFile(outputPath)
  } catch (error) {
    throw new ClassifiedPipelineError(
      'ARTIFACT_INVALID',
      `No se pudo leer pytorch-parity-reference.json generado: ${describeError(error)}`,
    )
  }
}

export const runContinuousTrainingIteration = async (
  deps: ContinuousTrainingPipelineDeps,
  config: ContinuousTrainingPipelineConfig,
  scanWatermark: Date,
): Promise<ContinuousTrainingIterationResult> => {
  const startedAt = deps.clock.now()
  const nextScanWatermark = await advanceRequestedThrough(deps, config, scanWatermark, startedAt)

  const snapshot = await deps.coordinator.getSnapshot()
  if (snapshot.requestedThrough.getTime() <= snapshot.processedThrough.getTime()) {
    return { outcome: { kind: 'IDLE' }, nextScanWatermark }
  }

  const claim = await deps.coordinator.tryClaimLease(
    config.ownerId,
    config.leaseDurationMs,
    startedAt,
  )
  if (claim === null) {
    return { outcome: { kind: 'LEASE_BUSY' }, nextScanWatermark }
  }
  deps.logger.info('continuous_training_lease_claimed', {
    ownerId: config.ownerId,
    fencingToken: claim.fencingToken,
  })

  // Revision de codigo (#571): el cutoff NO es simplemente `requestedThrough`
  // (el `finishedAt` crudo de la battle room). `MctsTeacherLabel`/
  // `CombatDecisionEvent` se persisten de forma asincrona (telemetria
  // best-effort, `LiveMctsTeacherLabeler`) y pueden quedar escritos
  // segundos DESPUES de `finishedAt` -- usar `finishedAt` tal cual como
  // cutoff excluiria esos labels del dataset (el builder ya falla cerrado
  // ante labels faltantes), causando un `DATASET_BUILD_FAILED` recurrente
  // aunque el label SI exista, solo un poco mas tarde. El mismo periodo de
  // gracia que ya protege `requestedThrough` (#571 §5.1) se aplica AQUI
  // tambien, como margen explicito sobre el valor del cutoff -- nunca mas
  // alla de "ahora" (`startedAt`), que seria leer el futuro.
  const cutoff = minDate(
    new Date(snapshot.requestedThrough.getTime() + config.gracePeriodMs),
    startedAt,
  )

  let running: RunningChildProcess | null = null
  const trackRunning = (next: RunningChildProcess | null): void => {
    running = next
  }
  // Objeto mutable, nunca un `let boolean` (#571 §6.2): el heartbeat lo
  // escribe desde un callback de `setInterval` que corre concurrentemente
  // con el resto de esta funcion -- TypeScript angostaria un `let`
  // primitivo a "siempre false" en cualquier punto posterior del cuerpo
  // sincrono, que seria una lectura incorrecta de la realidad (el
  // callback SI puede haber corrido entre dos `await` cualquiera).
  const leaseLostRef: { current: boolean } = { current: false }
  const heartbeat = setInterval(() => {
    void deps.coordinator
      .renewLease(claim, config.leaseDurationMs, deps.clock.now())
      .then((renewed) => {
        if (!renewed) {
          leaseLostRef.current = true
          deps.logger.error('continuous_training_lease_lost', { ownerId: config.ownerId })
          running?.cancel('SIGTERM')
        }
      })
      .catch((error: unknown) => {
        deps.logger.error('continuous_training_heartbeat_error', {
          ownerId: config.ownerId,
          reason: describeError(error),
        })
      })
  }, config.heartbeatIntervalMs)

  // `workDir` se crea DENTRO del try/finally (revision de codigo, #571):
  // si `mkdir`/`mkdtemp` fallan (disco lleno, permisos), el heartbeat de
  // mas arriba quedaria corriendo para siempre si esto viviera afuera.
  let workDir: string | null = null

  try {
    await mkdir(config.workRootDir, { recursive: true })
    workDir = await mkdtemp(join(config.workRootDir, 'ai-training-'))
    const datasetDir = join(workDir, 'dataset')
    const artifactsDir = join(workDir, 'artifacts')

    await buildDataset(deps, config, datasetDir, cutoff, trackRunning)

    const datasetManifestRaw = JSON.parse(
      await readFile(join(datasetDir, 'manifest.json'), 'utf8'),
    ) as unknown
    const datasetManifest = parseAndValidateDatasetManifest(datasetManifestRaw)

    if (!isDatasetTrainable(datasetManifest.counts)) {
      const reason = `train/validation/test decisions = ${String(datasetManifest.counts.trainDecisions)}/${String(datasetManifest.counts.validationDecisions)}/${String(datasetManifest.counts.testDecisions)}`
      deps.logger.info('continuous_training_not_trainable', {
        cutoff: cutoff.toISOString(),
        reason,
      })

      // Revision de codigo (#571 §7.3): "no entrenable" puede ser
      // TEMPORAL (labels todavia en vuelo para decisiones de ESTE
      // cutoff) -- avanzar `processedThrough` en la PRIMERA deteccion
      // podria dejar ese corte sin reintentarse nunca si no llega
      // ninguna partida nueva despues. Se reintenta el MISMO cutoff
      // (con backoff, `consecutiveFailureCount`) hasta
      // `maxNotTrainableRetries` veces antes de darlo por definitivo.
      if (snapshot.consecutiveFailureCount < config.maxNotTrainableRetries) {
        const retried = await deps.coordinator.recordNotTrainableRetry(
          claim,
          reason,
          deps.clock.now(),
        )
        if (!retried) {
          return {
            outcome: { kind: 'FAILED', reasonCode: 'LEASE_LOST', reason: 'lease perdido' },
            nextScanWatermark,
          }
        }
        return { outcome: { kind: 'NOT_TRAINABLE', reason }, nextScanWatermark }
      }

      const recorded = await deps.coordinator.recordNotTrainable(
        claim,
        cutoff,
        reason,
        deps.clock.now(),
      )
      if (!recorded) {
        return {
          outcome: { kind: 'FAILED', reasonCode: 'LEASE_LOST', reason: 'lease perdido' },
          nextScanWatermark,
        }
      }
      return { outcome: { kind: 'NOT_TRAINABLE', reason }, nextScanWatermark }
    }

    const identity = await emitTrainingIdentity(deps, config, datasetDir, trackRunning)
    deps.logger.info('continuous_training_identity_emitted', {
      modelVersion: identity.runId,
      trainingConfigSha256: identity.trainingConfigSha256,
    })

    if (leaseLostRef.current) {
      throw new ClassifiedPipelineError('LEASE_LOST', 'lease perdido antes de startTraining')
    }

    // Recuperacion idempotente (revision de codigo, #571): `trainingRunId`
    // es determinista -- si un intento ANTERIOR ya completo
    // `registerCandidate()` (o incluso algo posterior, p. ej. `#572`
    // evaluando/activando/rechazando) pero murio antes de
    // `coordinator.recordSuccess()`, reentrenar aqui NO solo desperdicia
    // el trabajo: `AiModelVersion.registerCandidate` SOLO permite
    // `TRAINING -> CANDIDATE`, asi que reintentarlo sobre una version que
    // ya paso de `TRAINING` lanzaria `InvalidModelStateTransitionError`.
    // Si la version ya existe y ya no esta en `TRAINING`, el trabajo de
    // ESTE cutoff ya esta resuelto: solo falta confirmarlo en el
    // coordinador, nunca repetir el entrenamiento.
    const existing = await deps.registry.findByVersion(identity.runId)
    if (existing !== null && existing.state !== 'TRAINING') {
      deps.logger.info('continuous_training_recovered_existing_version', {
        modelVersion: existing.modelVersion,
        state: existing.state,
      })
      const recovered = await deps.coordinator.recordSuccess(
        claim,
        cutoff,
        existing.modelVersion,
        deps.clock.now(),
      )
      if (!recovered) {
        throw new ClassifiedPipelineError(
          'LEASE_LOST',
          'lease perdido al recuperar una version existente',
        )
      }
      return {
        outcome: { kind: 'SUCCESS', modelVersion: existing.modelVersion },
        nextScanWatermark,
      }
    }

    const lineage: AiModelTrainingLineage = {
      modelVersion: identity.runId,
      trainingRunId: identity.runId,
      modelArchitectureVersion: NEURAL_MODEL_ARCHITECTURE_VERSION,
      featureSchemaVersion: datasetManifest.featureSchemaVersion,
      teacherVersion: datasetManifest.teacherVersion,
      utilityVersion: datasetManifest.utilityVersion,
      trainingSourceCommit: config.sourceCommit,
      datasetSourceCommit: datasetManifest.sourceCommit,
      datasetInputFingerprint: datasetManifest.inputFingerprint,
      datasetOutputFingerprint: identity.datasetOutputFingerprint,
      datasetCutoff: datasetManifest.cutoff,
      datasetSeed: datasetManifest.datasetSeed,
      trainingSeed: config.trainingSeed,
      trainingConfigSha256: identity.trainingConfigSha256,
    }

    const stillOwnerBeforeTraining = await deps.coordinator.renewLease(
      claim,
      config.leaseDurationMs,
      deps.clock.now(),
    )
    if (!stillOwnerBeforeTraining) {
      throw new ClassifiedPipelineError('LEASE_LOST', 'lease perdido antes de startTraining')
    }

    await deps.registry.startTraining(lineage)
    deps.logger.info('continuous_training_registered_training', {
      modelVersion: lineage.modelVersion,
    })

    await runTraining(deps, config, datasetDir, artifactsDir, trackRunning)

    const runDir = join(artifactsDir, identity.runId)
    const [onnxBytes, metricsBytes, manifestBytes] = await Promise.all([
      readFile(join(runDir, 'model.onnx')),
      readFile(join(runDir, 'metrics.json')),
      readFile(join(runDir, 'training-manifest.json')),
    ]).catch((error: unknown) => {
      throw new ClassifiedPipelineError(
        'ARTIFACT_INVALID',
        `No se pudieron leer los artefactos del run "${identity.runId}": ${describeError(error)}`,
      )
    })

    let manifest: ReturnType<typeof parseAndValidateModelTrainingManifest>
    try {
      manifest = parseAndValidateModelTrainingManifest(JSON.parse(manifestBytes.toString('utf8')))
    } catch (error) {
      throw new ClassifiedPipelineError(
        'ARTIFACT_INVALID',
        `training-manifest.json invalido: ${describeError(error)}`,
      )
    }

    const parityReferenceBytes = await generateParityReference(deps, config, runDir, trackRunning)
    const parityReferenceSha256 = createHash('sha256').update(parityReferenceBytes).digest('hex')

    const stillOwnerBeforeRegistering = await deps.coordinator.renewLease(
      claim,
      config.leaseDurationMs,
      deps.clock.now(),
    )
    if (!stillOwnerBeforeRegistering) {
      throw new ClassifiedPipelineError('LEASE_LOST', 'lease perdido antes de registerCandidate')
    }

    let candidateVersion: string
    try {
      const candidate = await deps.registry.registerCandidate({
        modelVersion: lineage.modelVersion,
        manifest: { ...manifest, parityReferenceSha256 },
        manifestBytes,
        onnxBytes,
        metricsBytes,
        parityReferenceBytes,
      })
      candidateVersion = candidate.modelVersion
    } catch (error) {
      throw new ClassifiedPipelineError('REGISTRY_REJECTED', describeError(error))
    }
    deps.logger.info('continuous_training_candidate_registered', { modelVersion: candidateVersion })

    const recorded = await deps.coordinator.recordSuccess(
      claim,
      cutoff,
      candidateVersion,
      deps.clock.now(),
    )
    if (!recorded) {
      deps.logger.error('continuous_training_success_but_lease_lost', {
        modelVersion: candidateVersion,
      })
      return {
        outcome: {
          kind: 'FAILED',
          reasonCode: 'LEASE_LOST',
          reason: 'lease perdido tras registrar CANDIDATE',
        },
        nextScanWatermark,
      }
    }

    return { outcome: { kind: 'SUCCESS', modelVersion: candidateVersion }, nextScanWatermark }
  } catch (error) {
    const reasonCode = leaseLostRef.current
      ? 'LEASE_LOST'
      : error instanceof ClassifiedPipelineError
        ? error.reasonCode
        : 'TRANSIENT_ERROR'
    const reason = describeError(error)
    deps.logger.error('continuous_training_run_failed', { reasonCode, reason })
    await deps.coordinator.recordFailure(claim, reasonCode, reason, deps.clock.now())
    return { outcome: { kind: 'FAILED', reasonCode, reason }, nextScanWatermark }
  } finally {
    clearInterval(heartbeat)
    // Fallo al limpiar el directorio temporal: no accionable, nunca debe
    // enmascarar el resultado real de la iteracion. `workDir` puede seguir
    // siendo `null` si `mkdir`/`mkdtemp` fueron justamente lo que fallo.
    if (workDir !== null) {
      await rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
        deps.logger.warn('continuous_training_workdir_cleanup_failed', {
          reason: describeError(error),
        })
      })
    }
  }
}

/** Identificador unico del proceso-propietario (#571 §6.1): nunca un simple PID, que se reutiliza entre procesos del sistema operativo. */
export const generateOwnerId = (): string =>
  `${hostname()}:${String(process.pid)}:${randomBytes(6).toString('hex')}`

export const defaultWorkRootDir = (): string => tmpdir()
