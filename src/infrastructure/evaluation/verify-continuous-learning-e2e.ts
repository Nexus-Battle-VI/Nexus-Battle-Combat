import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoAiEvaluationCoordinatorRepository } from '../../adapters/outbound/persistence/MongoAiEvaluationCoordinatorRepository'
import { MongoAiModelArtifactRepository } from '../../adapters/outbound/persistence/MongoAiModelArtifactRepository'
import { MongoAiModelRegistryRepository } from '../../adapters/outbound/persistence/MongoAiModelRegistryRepository'
import { MongoBattleRoomRepository } from '../../adapters/outbound/persistence/MongoBattleRoomRepository'
import { MongoContinuousTrainingCoordinatorRepository } from '../../adapters/outbound/persistence/MongoContinuousTrainingCoordinatorRepository'
import type { ClockPort } from '../../application/ports/ClockPort'
import { AiModelRegistry } from '../../application/services/AiModelRegistry'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../infrastructure/persistence/database'
import {
  generateOwnerId,
  runContinuousTrainingIteration,
  type ContinuousTrainingPipelineConfig,
  type ContinuousTrainingPipelineDeps,
} from '../../infrastructure/training/ContinuousTrainingPipeline'
import { spawnChildProcess } from '../../infrastructure/training/ChildProcessRunner'
// `finishedRoom`/`NOW` viven en `test/fixtures` (nunca en `src/`) a
// proposito: la guarda estatica de HU-21 (`test/unit/hu-21-finish-guards.spec.ts`)
// exige que el texto literal del metodo de cierre del agregado NUNCA
// aparezca fuera de `BattleRoom.ts` en todo `src/` -- construir aqui una
// sala terminada a mano lo violaria. Este script reutiliza el MISMO
// fixture que ya usa `continuous-training-worker-e2e.spec.ts` (EN-037.2)
// para el mismo proposito exacto (una `BattleRoom` cualquiera, ya cerrada,
// solo para que el pipeline tenga un `finishedAt` del que avanzar su
// watermark -- el dataset real nunca depende de su contenido).
import {
  finishedRoom,
  silentLogger,
  NOW as FIXTURE_FINISHED_AT,
} from '../../../test/fixtures/battle'
import { ActiveModelProvider } from '../ai/ActiveModelProvider'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'
import { processNextAutomaticEvaluation } from './AutomaticModelEvaluationCoordinator'
import { runAiEvaluation } from './run-ai-evaluation'

const AI_DIR = resolve(__dirname, '../../../ai')
const FIXTURES_DIR = join(AI_DIR, 'tests', 'fixtures', 'training')
/** El instante exacto que usa internamente `finishedRoom()` (`test/fixtures/battle.ts`). */
const FINISHED_AT = FIXTURE_FINISHED_AT
const NOW = new Date(FINISHED_AT.getTime() + 10_000)
const fixedClock: ClockPort = { now: () => NOW }

const logger: Logger = {
  debug: () => undefined,
  info: (message, context) => process.stderr.write(`${message} ${JSON.stringify(context ?? {})}\n`),
  warn: (message, context) => process.stderr.write(`${message} ${JSON.stringify(context ?? {})}\n`),
  error: (message, context) =>
    process.stderr.write(`${message} ${JSON.stringify(context ?? {})}\n`),
}
const readJsonlDocuments = async (path: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Mismo mapeo que `continuous-training-worker-e2e.spec.ts` (EN-037.2). */
const toDecisionEventDocument = (line: Record<string, unknown>): Record<string, unknown> => {
  const { eventId, occurredAt, ...rest } = line
  return { _id: eventId, ...rest, occurredAt: new Date(occurredAt as string) }
}

const toTeacherLabelDocument = (line: Record<string, unknown>): Record<string, unknown> => {
  const { eventId, generatedAt, ...rest } = line
  return { _id: eventId, ...rest, generatedAt: new Date(generatedAt as string) }
}

const isUvAvailable = (): boolean => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Entrena una CANDIDATE REAL sobre Mongo real (mismo fixture JSONL, misma
 * honestidad de etiquetado que EN-037.2: NO es telemetria de jugadores
 * reales, es sintetica con la FORMA real del contrato) y devuelve su
 * `modelVersion`. Nunca InMemory -- a diferencia de
 * `verify-automatic-model-promotion-e2e.ts` (#572), esta version parte de
 * Mongo real de punta a punta, cerrando la brecha que #574 identifico.
 */
const trainRealCandidate = async (
  db: Db,
  mongoUri: string,
  databaseName: string,
  trainingSeed: number,
  sourceCommit: string,
): Promise<{ readonly modelVersion: string; readonly registry: AiModelRegistry }> => {
  const decisionEvents = await readJsonlDocuments(join(FIXTURES_DIR, 'decision-events.jsonl'))
  const teacherLabels = await readJsonlDocuments(join(FIXTURES_DIR, 'teacher-labels.jsonl'))
  await db
    .collection('combat-decision-events')
    .insertMany(decisionEvents.map(toDecisionEventDocument))
  await db.collection('mcts-teacher-labels').insertMany(teacherLabels.map(toTeacherLabelDocument))

  const battleRooms = new MongoBattleRoomRepository(db)
  await battleRooms.save(finishedRoom(), 0)

  const workRootDir = await mkdtemp(join(tmpdir(), 'en037-5-training-'))
  const registry = new AiModelRegistry(
    new MongoAiModelRegistryRepository(db),
    new MongoAiModelArtifactRepository(db),
    fixedClock,
  )
  const config: ContinuousTrainingPipelineConfig = {
    ownerId: generateOwnerId(),
    aiDir: AI_DIR,
    pythonCommand: 'uv',
    mongoUri,
    databaseName,
    datasetSeed: 42,
    trainingSeed,
    sourceCommit,
    gracePeriodMs: 1_000,
    leaseDurationMs: 5 * 60_000,
    heartbeatIntervalMs: 20_000,
    datasetBuildTimeoutMs: 90_000,
    trainingTimeoutMs: 180_000,
    identityTimeoutMs: 90_000,
    workRootDir,
    maxNotTrainableRetries: 3,
  }
  const deps: ContinuousTrainingPipelineDeps = {
    battleRooms,
    coordinator: new MongoContinuousTrainingCoordinatorRepository(db),
    registry,
    clock: fixedClock,
    logger: silentLogger,
    runChildProcess: spawnChildProcess,
  }

  const { outcome } = await runContinuousTrainingIteration(deps, config, new Date(0))
  assert.equal(outcome.kind, 'SUCCESS', `entrenamiento real fallo: ${JSON.stringify(outcome)}`)
  assert.equal((outcome as { modelVersion: string }).modelVersion !== '', true)

  return { modelVersion: (outcome as { modelVersion: string }).modelVersion, registry }
}

/**
 * EN-037.5 (Management #574), Escenario E2E-11: un ACTIVE corrupto (bytes
 * ONNX invalidos) NUNCA debe instalarse como politica valida.
 *
 * Fixture de ingenieria DELIBERADO (#574 §13, "no sobrescribir un modelo
 * valido con bytes corruptos y declarar exito si el error quedo oculto"):
 * se simula corrupcion EN REPOSO (bit rot / intervencion manual), nunca una
 * promocion sin evaluacion -- se escribe directamente en los repositorios
 * Mongo de una base AISLADA (nunca la base donde corrio el pipeline real de
 * arriba), nunca via `AiModelRegistry.promoteEvaluatedCandidate`.
 */
const verifyCorruptActiveFailsafe = async (client: MongoClient): Promise<void> => {
  const db = databaseOf(client, {
    uri: '',
    databaseName: `en037_5_corrupt_active_e2e_${String(Date.now())}`,
  })
  const migrated = await migrateToLatest(db)
  if (migrated.error !== undefined)
    throw migrated.error instanceof Error ? migrated.error : new Error('La migracion fallo.')

  const registryRepo = new MongoAiModelRegistryRepository(db)
  const artifacts = new MongoAiModelArtifactRepository(db)
  const registry = new AiModelRegistry(registryRepo, artifacts, fixedClock)

  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

  // Bytes HONESTAMENTE invalidos como ONNX (nunca un protobuf real) -- el
  // registro nunca recibe un hash mentido: cada sha256 de abajo es el
  // REAL de estos bytes, calculado aqui con el mismo algoritmo que
  // `AiModelRegistry` usa internamente (`sha256HexOf`). Lo unico "falso" es
  // el CONTENIDO del archivo .onnx, nunca su integridad declarada.
  const corruptOnnxBytes = Buffer.from('esto no es un protobuf de ONNX valido', 'utf8')
  const metricsBytes = Buffer.from('{}', 'utf8')
  const parityReferenceBytes = Buffer.from('{}', 'utf8')
  const fakePytorchArtifactSha256 = 'a'.repeat(64)
  const fakeModelStateSha256 = 'b'.repeat(64)
  const fakeDatasetFingerprint = 'c'.repeat(64)
  const fakeTrainingConfigSha256 = 'd'.repeat(64)

  const modelVersion = 'en037-5-corrupt-active-fixture-v1'
  const sharedLineageFields = {
    modelArchitectureVersion: 'candidate-mlp-v1',
    featureSchemaVersion: 'feature-schema-v1',
    teacherVersion: 'mcts-teacher-v1',
    utilityVersion: 'combat-utility-v1',
    trainingSourceCommit: 'en037-5-corrupt-fixture',
    datasetSourceCommit: 'en037-5-corrupt-fixture',
    datasetInputFingerprint: fakeDatasetFingerprint,
    datasetOutputFingerprint: fakeDatasetFingerprint,
    datasetCutoff: NOW.toISOString(),
    datasetSeed: 42,
    trainingConfigSha256: fakeTrainingConfigSha256,
  }

  await registry.startTraining({
    modelVersion,
    trainingRunId: modelVersion,
    trainingSeed: 1,
    ...sharedLineageFields,
  })

  const manifestObject = {
    ...sharedLineageFields,
    trainingConfig: { trainingSeed: 1 },
    datasetCounts: { battles: 1, decisions: 1 },
    modelStateSha256: fakeModelStateSha256,
    onnxArtifactSha256: sha256(corruptOnnxBytes),
    pytorchArtifactSha256: fakePytorchArtifactSha256,
    metricsFileSha256: sha256(metricsBytes),
    parityReferenceSha256: sha256(parityReferenceBytes),
    artifactPurpose: 'CANDIDATE',
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifestObject), 'utf8')

  // `registerCandidate` recalcula el sha256 de CADA buffer dado (nunca
  // confia en el que el manifest declara) -- esta prueba nunca miente ese
  // hash, le da honestamente el de un ONNX INVALIDO. Si esto solo no
  // bastara para llegar a CANDIDATE, seria un hallazgo (defensa en
  // profundidad adicional); si pasa, demuestra exactamente lo que #574
  // §13 pide comprobar: integridad de BYTES (hash) no es lo mismo que
  // validez de CONTENIDO (ONNX real) -- esta ultima la exige
  // `ActiveModelProvider`/`loadValidatedNeuralArtifact`, nunca el registro.
  await registry.registerCandidate({
    modelVersion,
    manifest: manifestObject,
    manifestBytes,
    onnxBytes: corruptOnnxBytes,
    metricsBytes,
    parityReferenceBytes,
  })

  // `CANDIDATE -> EVALUATING -> ACTIVE` via las PROPIAS primitivas del
  // registro (nunca `promoteEvaluatedCandidate`, que exige evidencia real
  // de gates) -- simula honestamente que, por la via que sea (bit rot
  // posterior, intervencion manual, un bug en OTRO componente), un
  // artefacto con integridad de hash consistente pero contenido ONNX
  // invalido termino como ACTIVE. `activate()` ya vuelve a comprobar la
  // integridad del artefacto (`assertArtifactIntegrity`): si llega a
  // rechazarlo aqui, ES otra capa real de defensa en profundidad, y esta
  // prueba lo documenta como tal.
  await registry.beginEvaluation(modelVersion)
  await registry.activate(modelVersion)
  const activeNow = await registry.findActive()
  assert.equal(
    activeNow?.modelVersion,
    modelVersion,
    'el ACTIVE corrupto no quedo activo como se esperaba para esta prueba',
  )

  const workRoot = await mkdtemp(join(tmpdir(), 'en037-5-corrupt-active-'))
  try {
    const provider = new ActiveModelProvider(registry, artifacts, logger, {
      enabled: true,
      autoStart: false,
      pollIntervalMs: 30_000,
      nodeEnv: 'test',
      inferenceTimeoutMs: 2_000,
      workRootDir: workRoot,
    })
    await provider.refresh()

    await assert.rejects(
      provider.decide({} as BattleDecisionState, [] as readonly LegalAction[]),
      /ningun modelo ACTIVE cargado todavia/,
      'ActiveModelProvider instalo un ONNX invalido como politica utilizable -- esto NUNCA debe pasar.',
    )
    process.stderr.write(
      'EN-037.5 E2E-11 OK: ActiveModelProvider.refresh() ante un ACTIVE con ONNX invalido NO instalo ' +
        'ninguna politica (current sigue null) -- fallo seguro confirmado.\n',
    )
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

export const verifyContinuousLearningE2e = async (): Promise<void> => {
  if (!isUvAvailable()) {
    process.stderr.write(
      'EN-037.5: "uv" no esta en PATH -- esta E2E necesita Python real, se omite.\n',
    )
    return
  }

  const container: StartedMongoDBContainer = await new MongoDBContainer('mongo:8.0').start()
  const mongoUri = `${container.getConnectionString()}/?directConnection=true`
  const databaseName = `continuous_learning_e2e_${String(Date.now())}`
  const client = createMongoClient({ uri: mongoUri })
  await client.connect()
  const db = databaseOf(client, { uri: mongoUri, databaseName })

  try {
    const migrated = await migrateToLatest(db)
    if (migrated.error !== undefined)
      throw migrated.error instanceof Error ? migrated.error : new Error('La migracion fallo.')

    // --- Fase D (#574 §8): entrenamiento REAL -> CANDIDATE REAL, Mongo real. ---
    const { modelVersion, registry } = await trainRealCandidate(
      db,
      mongoUri,
      databaseName,
      /* trainingSeed */ 7,
      'continuous-learning-e2e-v1',
    )
    process.stderr.write(`EN-037.5: CANDIDATE real registrada: ${modelVersion}\n`)

    // E2E-18 (parcial): una CANDIDATE pendiente nunca toca el ACTIVE vigente
    // (aqui, ninguno) mientras el evaluador no corrio todavia.
    assert.equal(await registry.findActive(), null)

    // --- Fase E/F/G (#574 §9/10/11): evaluacion automatica REAL. ---
    const ledger = new MongoAiEvaluationCoordinatorRepository(db)
    const artifacts = new MongoAiModelArtifactRepository(db)
    const evalWorkRoot = await mkdtemp(join(tmpdir(), 'en037-5-eval-'))
    const outcome = await processNextAutomaticEvaluation(
      {
        registry,
        ledger,
        artifactRepository: artifacts,
        clock: fixedClock,
        logger,
        runEvaluation: runAiEvaluation,
      },
      {
        ownerId: 'en037-5-e2e-evaluator',
        leaseDurationMs: 120_000,
        heartbeatIntervalMs: 20_000,
        workRootDir: evalWorkRoot,
        seedStart: 3_000_000,
        seedCount: 10,
        mctsSeedCount: 3,
        maxPlies: 500,
        sourceCommit: 'continuous-learning-e2e-v1',
        skipExpensiveMcts: true,
      },
    )

    if (outcome.kind === 'INFRASTRUCTURE_FAILURE') {
      throw new Error(`evaluacion automatica fallo tecnicamente: ${outcome.reason}`)
    }
    assert.notEqual(outcome.kind, 'IDLE')
    assert.notEqual(outcome.kind, 'LEASE_BUSY')

    const evidence = await ledger.getByModelVersion(modelVersion)
    assert.ok(evidence, 'no quedo evidencia de evaluacion en el ledger real')
    assert.equal(evidence.status, 'DECIDED')
    assert.equal(evidence.promotionPolicyVersion, 'promotion-policy-v1')

    const stored = await registry.findByVersion(modelVersion)
    assert.ok(stored)

    if (outcome.kind === 'PROMOTED') {
      // --- Fase G/H (#574 §11/12): CANDIDATE -> ACTIVE real + hot reload real. ---
      assert.equal(stored.state, 'ACTIVE')
      assert.equal(evidence.evaluationOutcome, 'PASS')
      process.stderr.write(
        `EN-037.5: PROMOCION REAL confirmada (${modelVersion}) -- gates PASS genuinos, ` +
          'nunca umbrales relajados.\n',
      )

      const providerWorkRoot = await mkdtemp(join(tmpdir(), 'en037-5-hot-reload-'))
      try {
        const provider = new ActiveModelProvider(registry, artifacts, logger, {
          enabled: true,
          autoStart: false,
          pollIntervalMs: 30_000,
          nodeEnv: 'test',
          inferenceTimeoutMs: 2_000,
          workRootDir: providerWorkRoot,
        })
        await provider.refresh()

        const fixture = JSON.parse(
          await readFile(join(AI_DIR, 'tests', 'fixtures', 'golden-multi-candidate.json'), 'utf8'),
        ) as {
          readonly state: BattleDecisionState
          readonly candidates: Record<string, { readonly action: LegalAction }>
        }
        const legalActions = Object.values(fixture.candidates).map((entry) => entry.action)
        const selected = await provider.decide(fixture.state, legalActions)
        assert.ok(
          legalActions.some((action) => JSON.stringify(action) === JSON.stringify(selected)),
        )
        process.stderr.write(
          'EN-037.5 E2E-10 OK: ActiveModelProvider cargo el ACTIVE recien promovido y produjo una ' +
            'decision legal real -- sin reiniciar Combat.\n',
        )
      } finally {
        await rm(providerWorkRoot, { recursive: true, force: true })
      }
    } else {
      assert.equal(outcome.kind, 'REJECTED')
      assert.equal(stored.state, 'REJECTED')
      assert.equal(evidence.evaluationOutcome, 'FAIL')
      assert.equal(await registry.findActive(), null)
      process.stderr.write(
        `EN-037.5: RECHAZO REAL confirmado (${modelVersion}). Razones de gates reales: ` +
          `${JSON.stringify(outcome.reasons)}. Esto es un resultado HONESTO esperado -- un modelo ` +
          'entrenado sobre el fixture minimo de EN-037.2 no tiene por que superar los umbrales de ' +
          'promotion-policy-v1 (60% vs Random, 50% vs RuleBased); #574 EXIGE reportar este bloqueo ' +
          'con evidencia real, nunca fabricar un PASS.\n',
      )
    }

    // --- Fase I (#574 §13): E2E-11, siempre, en una base aislada. ---
    await verifyCorruptActiveFailsafe(client)

    process.stderr.write(`EN-037.5 E2E OK de punta a punta (${outcome.kind}, ${modelVersion})\n`)
  } finally {
    await db.dropDatabase().catch(() => undefined)
    await client.close()
    await container.stop()
  }
}

if (require.main === module) {
  void verifyContinuousLearningE2e().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : describeError(error)
    process.stderr.write(`${detail}\n`)
    process.exitCode = 1
  })
}
