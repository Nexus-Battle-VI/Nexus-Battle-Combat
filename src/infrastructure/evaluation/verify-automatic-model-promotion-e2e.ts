import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { InMemoryAiEvaluationCoordinatorRepository } from '../../adapters/outbound/persistence/InMemoryAiEvaluationCoordinatorRepository'
import { InMemoryAiModelArtifactRepository } from '../../adapters/outbound/persistence/InMemoryAiModelArtifactRepository'
import { InMemoryAiModelRegistryRepository } from '../../adapters/outbound/persistence/InMemoryAiModelRegistryRepository'
import type { ClockPort } from '../../application/ports/ClockPort'
import { AiModelRegistry } from '../../application/services/AiModelRegistry'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { AiModelTrainingLineage } from '../../domain/entities/AiModelVersion'
import { ActiveModelProvider } from '../ai/ActiveModelProvider'
import { parseAndValidateModelTrainingManifest } from '../ai/AiModelTrainingManifestV1'
import type { Logger } from '../observability/logger'
import { processNextAutomaticEvaluation } from './AutomaticModelEvaluationCoordinator'
import { runAiEvaluation } from './run-ai-evaluation'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const clock: ClockPort = { now: () => new Date('2027-01-01T00:00:00.000Z') }
const logger: Logger = {
  debug: () => undefined,
  info: (message, context) => process.stderr.write(`${message} ${JSON.stringify(context ?? {})}\n`),
  warn: (message, context) => process.stderr.write(`${message} ${JSON.stringify(context ?? {})}\n`),
  error: (message, context) =>
    process.stderr.write(`${message} ${JSON.stringify(context ?? {})}\n`),
}

/**
 * E2E de ingenieria EN-037.3. Corre fuera de Jest porque el sandbox VM de
 * Jest crea un constructor Float32Array distinto al que valida el addon
 * nativo de onnxruntime-node. Este proceso usa el runtime Node real, igual
 * que `run-ai-evaluation.js` y produccion; nunca mockea ONNX ni los gates.
 */
export const verifyAutomaticModelPromotionE2e = async (artifactDir: string): Promise<void> => {
  const workRoot = await mkdtemp(join(tmpdir(), 'en037-e2e-'))
  try {
    const [manifestBytes, onnxBytes, metricsBytes, parityReferenceBytes] = await Promise.all([
      readFile(join(artifactDir, 'training-manifest.json')),
      readFile(join(artifactDir, 'model.onnx')),
      readFile(join(artifactDir, 'metrics.json')),
      readFile(join(artifactDir, 'pytorch-parity-reference.json')),
    ])
    const manifest = parseAndValidateModelTrainingManifest(
      JSON.parse(manifestBytes.toString('utf8')) as unknown,
    )
    assert.equal(manifest.artifactPurpose, 'CANDIDATE')

    const modelVersion = basename(artifactDir)
    const trainingSeed = manifest.trainingConfig.trainingSeed
    assert.equal(typeof trainingSeed, 'number', 'trainingConfig.trainingSeed missing')
    const lineage: AiModelTrainingLineage = {
      modelVersion,
      trainingRunId: modelVersion,
      modelArchitectureVersion: manifest.modelArchitectureVersion,
      featureSchemaVersion: manifest.featureSchemaVersion,
      teacherVersion: manifest.teacherVersion,
      utilityVersion: manifest.utilityVersion,
      trainingSourceCommit: manifest.trainingSourceCommit,
      datasetSourceCommit: manifest.datasetSourceCommit,
      datasetInputFingerprint: manifest.datasetInputFingerprint,
      datasetOutputFingerprint: manifest.datasetOutputFingerprint,
      datasetCutoff: manifest.datasetCutoff,
      datasetSeed: manifest.datasetSeed,
      trainingSeed: trainingSeed as number,
      trainingConfigSha256: manifest.trainingConfigSha256,
    }

    const artifacts = new InMemoryAiModelArtifactRepository()
    const registry = new AiModelRegistry(new InMemoryAiModelRegistryRepository(), artifacts, clock)
    const ledger = new InMemoryAiEvaluationCoordinatorRepository()
    await registry.startTraining(lineage)
    await registry.registerCandidate({
      modelVersion,
      manifest: { ...manifest, parityReferenceSha256: sha256(parityReferenceBytes) },
      manifestBytes,
      onnxBytes,
      metricsBytes,
      parityReferenceBytes,
    })

    const outcome = await processNextAutomaticEvaluation(
      {
        registry,
        ledger,
        artifactRepository: artifacts,
        clock,
        logger,
        runEvaluation: runAiEvaluation,
      },
      {
        ownerId: 'en037-e2e-worker',
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 10_000,
        workRootDir: workRoot,
        seedStart: 3_000_000,
        seedCount: 2,
        mctsSeedCount: 1,
        maxPlies: 300,
        sourceCommit: manifest.trainingSourceCommit,
        skipExpensiveMcts: true,
      },
    )
    if (outcome.kind === 'INFRASTRUCTURE_FAILURE') throw new Error(outcome.reason)
    if (outcome.kind === 'IDLE' || outcome.kind === 'LEASE_BUSY') {
      throw new Error(`unexpected coordinator outcome: ${outcome.kind}`)
    }

    const evidence = await ledger.getByModelVersion(modelVersion)
    assert.ok(evidence)
    assert.equal(evidence.status, 'DECIDED')
    assert.equal(evidence.promotionPolicyVersion, 'promotion-policy-v1')
    assert.equal(evidence.evaluationConfigVersion, 'evaluation-config-v1')
    assert.ok(evidence.evaluationId?.includes(manifest.modelStateSha256.slice(0, 12)))

    const stored = await registry.findByVersion(modelVersion)
    assert.ok(stored)
    if (outcome.kind === 'PROMOTED') {
      assert.equal(stored.state, 'ACTIVE')
      assert.equal(evidence.evaluationOutcome, 'PASS')
      assert.equal(evidence.promotionStatus, 'COMPLETED')

      const provider = new ActiveModelProvider(registry, artifacts, logger, {
        enabled: true,
        autoStart: false,
        pollIntervalMs: 30_000,
        nodeEnv: 'test',
        inferenceTimeoutMs: 2_000,
        workRootDir: workRoot,
      })
      await provider.refresh()
      const fixture = JSON.parse(
        await readFile(
          join(process.cwd(), 'ai/tests/fixtures/golden-multi-candidate.json'),
          'utf8',
        ),
      ) as {
        readonly state: BattleDecisionState
        readonly candidates: Record<string, { readonly action: LegalAction }>
      }
      const legalActions = Object.values(fixture.candidates).map((entry) => entry.action)
      const selected = await provider.decide(fixture.state, legalActions)
      assert.ok(legalActions.some((action) => JSON.stringify(action) === JSON.stringify(selected)))
    } else {
      assert.equal(outcome.kind, 'REJECTED')
      assert.equal(stored.state, 'REJECTED')
      assert.equal(evidence.evaluationOutcome, 'FAIL')
      assert.equal(await registry.findActive(), null)
    }

    process.stderr.write(`EN-037.3 E2E OK: ${outcome.kind} (${modelVersion})\n`)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  const artifactDir = process.env.AI_EN037_E2E_ARTIFACT_DIR
  if (artifactDir === undefined || artifactDir.trim() === '') {
    throw new Error('AI_EN037_E2E_ARTIFACT_DIR is required; this E2E never fabricates an artifact.')
  }
  await verifyAutomaticModelPromotionE2e(artifactDir)
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${detail}\n`)
    process.exitCode = 1
  })
}
