import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClockPort } from '../../application/ports/ClockPort'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../adapters/outbound/system/CdfUniformIndexMapper'
import { InMemoryMctsSimulationAdapter } from '../../adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { MctsSearch } from '../../application/services/MctsSearch'
import { MctsTeacher } from '../../application/services/MctsTeacher'
import { MCTS_TEACHER_V1_CONFIG } from '../../domain/decision/MctsTeacherResult'
import { OnnxRuntimeNeuralInferenceAdapter } from '../ai/OnnxRuntimeNeuralInferenceAdapter'
import { NeuralEvaluationPolicy } from '../../evaluation/policies/NeuralEvaluationPolicy'
import { MctsEvaluationPolicy } from '../../evaluation/policies/MctsEvaluationPolicy'
import { RuleBasedEvaluationPolicy } from '../../evaluation/policies/RuleBasedEvaluationPolicy'
import { EVALUATION_SCENARIOS } from '../../evaluation/battle/EvaluationScenarioCatalog'
import {
  REQUIRED_EVALUATION_MATCHUPS,
  type EvaluationConfig,
  type EvaluationPurpose,
} from '../../evaluation/experiment/EvaluationConfig'
import { assertUint32Seed } from '../../evaluation/experiment/EvaluationSeedSchedule'
import {
  runPolicyComparisonHarness,
  type PolicyComparisonHarnessDeps,
} from '../../evaluation/experiment/PolicyComparisonHarness'
import {
  buildEvaluationSummary,
  buildEvaluationSummaryMarkdown,
  buildMatchesJsonl,
} from '../../evaluation/experiment/EvaluationReport'
import {
  assertSameTrainingRun,
  loadParityReference,
  runParityValidation,
} from '../../evaluation/parity/OnnxPytorchParityValidator'
import { canonicalJsonStringify } from '../../evaluation/canonical/CanonicalJson'
import { describeError } from '../observability/describe-error'

/** Reloj FIJO (#569 §197): la evaluacion nunca depende de `Date.now()` real -- ni para el
 * gameplay ni para que dos corridas con la misma config produzcan timestamps distintos. */
const FIXED_EVALUATION_CLOCK: ClockPort = { now: () => new Date('2027-01-01T00:00:00.000Z') }

interface CliArgs {
  readonly artifactDir: string
  readonly output: string
  readonly purpose: EvaluationPurpose
  readonly seedStart: number
  readonly seedCount: number
  readonly mctsSeedCount: number
  readonly maxPlies: number
  readonly sourceCommit: string | null
  readonly skipExpensiveMcts: boolean
  readonly allowSmokeModel: boolean
}

const requireValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1]
  if (value === undefined) {
    throw new Error(`Falta el valor de "${flag}".`)
  }
  return value
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  let artifactDir: string | null = null
  let output: string | null = null
  let purpose: EvaluationPurpose | null = null
  let seedStart: number | null = null
  let seedCount: number | null = null
  let mctsSeedCount: number | null = null
  let maxPlies = 500
  let sourceCommit: string | null = null
  let skipExpensiveMcts = false
  let allowSmokeModel = false

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    switch (flag) {
      case '--artifact-dir':
        artifactDir = requireValue(argv, i, flag)
        i += 1
        break
      case '--output':
        output = requireValue(argv, i, flag)
        i += 1
        break
      case '--purpose': {
        const value = requireValue(argv, i, flag)
        if (value !== 'SMOKE_TEST' && value !== 'FULL_EVALUATION') {
          throw new Error('--purpose debe ser SMOKE_TEST o FULL_EVALUATION.')
        }
        purpose = value
        i += 1
        break
      }
      case '--seed-start':
        seedStart = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--seed-count':
        seedCount = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--mcts-seed-count':
        mctsSeedCount = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--max-plies':
        maxPlies = Number(requireValue(argv, i, flag))
        i += 1
        break
      case '--source-commit':
        sourceCommit = requireValue(argv, i, flag)
        i += 1
        break
      case '--skip-expensive-mcts':
        skipExpensiveMcts = true
        break
      case '--allow-smoke-model':
        allowSmokeModel = true
        break
      default:
        throw new Error(`Flag desconocido: "${String(flag)}".`)
    }
  }

  if (artifactDir === null) throw new Error('--artifact-dir es obligatorio.')
  if (output === null) throw new Error('--output es obligatorio.')
  if (purpose === null) throw new Error('--purpose es obligatorio.')
  if (seedStart === null) throw new Error('--seed-start es obligatorio.')
  if (seedCount === null) throw new Error('--seed-count es obligatorio.')
  if (mctsSeedCount === null) throw new Error('--mcts-seed-count es obligatorio.')

  return {
    artifactDir,
    output,
    purpose,
    seedStart: assertUint32Seed(seedStart, '--seed-start'),
    seedCount,
    mctsSeedCount,
    maxPlies,
    sourceCommit,
    skipExpensiveMcts,
    allowSmokeModel,
  }
}

const resolveSourceCommit = (explicit: string | null): string => {
  if (explicit !== null) return explicit

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  } catch (error) {
    throw new Error(
      `No se pudo determinar sourceCommit (sin --source-commit y sin \`git rev-parse HEAD\` ` +
        `disponible): ${describeError(error)}`,
      { cause: error },
    )
  }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const sourceCommit = resolveSourceCommit(args.sourceCommit)

  const onnxPath = join(args.artifactDir, 'model.onnx')
  const manifestPath = join(args.artifactDir, 'training-manifest.json')
  const parityReferencePath = join(args.artifactDir, 'pytorch-parity-reference.json')

  // 1. Validar el artefacto (#569 §174): misma autoridad de contrato que
  // produccion, y esta llamada SI lanza si algo no es valido.
  process.stderr.write('Cargando y validando el artefacto neuronal...\n')
  const neuralPolicy = await NeuralEvaluationPolicy.load({
    onnxPath,
    manifestPath,
    nodeEnv: 'development',
    allowSmokeModel: true,
    inferenceTimeoutMs: 2_000,
  })

  // 2. Validar paridad PyTorch <-> ONNX ANTES de correr ninguna partida
  // (#569 §174, §131: si falla, es un quality gate TECNICO, nunca un
  // warning).
  process.stderr.write('Validando paridad PyTorch <-> ONNX...\n')
  const parityReference = await loadParityReference(parityReferencePath)
  assertSameTrainingRun(parityReference, neuralPolicy.modelDescriptor)
  const parityAdapter = await OnnxRuntimeNeuralInferenceAdapter.create(onnxPath)
  const parityReport = await runParityValidation(parityReference, parityAdapter)

  process.stderr.write(
    `paridad: passed=${String(parityReport.passed)} argmaxAgreement=${String(parityReport.argmaxAgreement)} ` +
      `maxAbsoluteError=${String(parityReport.maxAbsoluteError)}\n`,
  )

  if (!parityReport.passed) {
    throw new Error(
      'La paridad PyTorch <-> ONNX fallo: no se ejecuta ninguna partida (#569 §131, §174).',
    )
  }

  // 3. Construir dependencias compartidas (#569 §147-150: Neural y MCTS
  // reutilizan UNA instancia stateless durante todo el run).
  const randomSequenceFactory = new Mt19937BoxMullerRandomSequenceFactory(
    new CdfUniformIndexMapper(),
  )
  const mctsConfig =
    args.purpose === 'SMOKE_TEST'
      ? { ...MCTS_TEACHER_V1_CONFIG, rollouts: 8 }
      : MCTS_TEACHER_V1_CONFIG
  const simulation = new InMemoryMctsSimulationAdapter(FIXED_EVALUATION_CLOCK)
  const mctsSearch = new MctsSearch(simulation, randomSequenceFactory)
  const mctsPolicy = new MctsEvaluationPolicy(new MctsTeacher(mctsSearch, mctsConfig))

  const config: EvaluationConfig = {
    configVersion: 'evaluation-config-v1',
    purpose: args.purpose,
    scenarioIds: EVALUATION_SCENARIOS.map((scenario) => scenario.scenarioId),
    matchups: REQUIRED_EVALUATION_MATCHUPS,
    seedStart: args.seedStart,
    seedCount: args.seedCount,
    mctsSeedCount: args.mctsSeedCount,
    mctsConfig,
    maxPlies: args.maxPlies,
    mirrorEnabled: true,
    neuralArtifact: {
      onnxPath,
      manifestPath,
      allowSmokeModel: args.allowSmokeModel,
      inferenceTimeoutMs: 2_000,
    },
    skipExpensiveMcts: args.skipExpensiveMcts,
    sourceCommit,
  }

  const deps: PolicyComparisonHarnessDeps = {
    randomSequenceFactory,
    ruleBasedPolicy: new RuleBasedEvaluationPolicy(),
    mctsPolicy,
    neuralPolicy,
    clock: FIXED_EVALUATION_CLOCK,
  }

  const evaluationId = `eval-${sourceCommit.slice(0, 12)}-${args.purpose}-seed${String(args.seedStart)}x${String(args.seedCount)}`

  process.stderr.write(`Ejecutando evaluacion ${evaluationId}...\n`)
  const results = await runPolicyComparisonHarness(
    config,
    deps,
    evaluationId,
    (_result, completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        process.stderr.write(`progreso: ${String(completed)}/${String(total)}\n`)
      }
    },
  )

  const summary = buildEvaluationSummary({
    evaluationId,
    config,
    results,
    model: neuralPolicy.modelDescriptor,
    parity: parityReport,
  })

  await mkdir(args.output, { recursive: true })
  await writeFile(join(args.output, 'matches.jsonl'), buildMatchesJsonl(results), 'utf-8')
  await writeFile(join(args.output, 'summary.json'), canonicalJsonStringify(summary), 'utf-8')
  await writeFile(join(args.output, 'summary.md'), buildEvaluationSummaryMarkdown(summary), 'utf-8')
  await writeFile(
    join(args.output, 'evaluation-config.json'),
    canonicalJsonStringify(config),
    'utf-8',
  )
  await writeFile(
    join(args.output, 'parity-report.json'),
    canonicalJsonStringify(parityReport),
    'utf-8',
  )

  const invariantViolations = results.filter((r) => r.status === 'INVARIANT_VIOLATION').length
  const engineFailures = results.filter((r) => r.status === 'ENGINE_FAILURE').length

  process.stderr.write(
    `totalMatches=${String(results.length)} invariantViolations=${String(invariantViolations)} ` +
      `engineFailures=${String(engineFailures)} matchesSha256=${summary.fingerprints.matchesSha256}\n`,
  )

  if (invariantViolations > 0 || engineFailures > 0) {
    throw new Error(
      `Evaluacion INVALIDA: ${String(invariantViolations)} violaciones de invariante y ` +
        `${String(engineFailures)} fallos del motor (#569 §24, §57, §175). Ver ${args.output}/matches.jsonl.`,
    )
  }

  process.stderr.write('evaluacion valida: 0 violaciones de invariante, 0 fallos del motor.\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`ai_evaluation_invalid: ${describeError(error)}\n`)
  process.exitCode = 1
})
