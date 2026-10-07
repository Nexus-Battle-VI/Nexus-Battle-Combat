import { loadConfig } from '../config/env'
import { createLogger } from '../observability/logger'
import { describeError } from '../observability/describe-error'
import { FEATURE_DIMENSION } from '../../application/services/FeatureEncoderV1'
import { loadNeuralPrimaryPolicy } from './NeuralModelArtifactLoader'
import { OnnxRuntimeNeuralInferenceAdapter } from './OnnxRuntimeNeuralInferenceAdapter'

/**
 * Punto de entrada de `npm run validate:neural-artifact` (EN-036.4,
 * Management #568 §65-66, §103, §154): smoke REAL del runtime nativo de
 * ONNX Runtime contra un artefacto de #567 -- pensado para ejecutarse
 * DENTRO de la imagen final de Combat en CI (`docker run ... node dist/
 * infrastructure/ai/validate-neural-artifact.js`), nunca como parte de
 * `npm run test:unit`/`test:integration` (esas NUNCA dependen del binario
 * nativo, #568 §102).
 *
 * Reutiliza el loader/adapter REALES de produccion -- ninguna logica
 * paralela (#568 §66): si esto pasa, el wiring productivo tambien
 * funcionaria con ese mismo artefacto montado.
 *
 * Requiere exactamente la misma configuracion que produccion:
 * `NEURAL_POLICY_ENABLED=true`, `NEURAL_MODEL_ONNX_PATH`,
 * `NEURAL_MODEL_MANIFEST_PATH`, y (para el artefacto SMOKE_TEST que #567
 * produce hoy) `NEURAL_ALLOW_SMOKE_MODEL=true` fuera de produccion.
 */
const main = async (): Promise<void> => {
  const config = loadConfig(process.env)
  const logger = createLogger({
    level: config.logLevel,
    service: config.serviceName,
    version: config.version,
  })

  if (!config.neuralPolicyEnabled) {
    throw new Error('NEURAL_POLICY_ENABLED debe ser "true" para validar un artefacto neuronal.')
  }
  if (config.neuralModelOnnxPath === null) {
    throw new Error('NEURAL_MODEL_ONNX_PATH es obligatorio para validar un artefacto neuronal.')
  }

  const binding = await loadNeuralPrimaryPolicy(config, logger)
  if (binding === null) {
    throw new Error(
      'El artefacto neuronal no cargo (ver el log "neural_model_unavailable" de arriba para la ' +
        'razon exacta).',
    )
  }

  // Smoke EXPLICITO con 3 candidatos (#568 §61), mas alla del [1,F] que ya
  // corrio dentro de `loadNeuralPrimaryPolicy` -- misma sesion, otra
  // inferencia real, nunca un mock.
  const adapter = await OnnxRuntimeNeuralInferenceAdapter.create(config.neuralModelOnnxPath)
  const scores = await adapter.score(new Float32Array(3 * FEATURE_DIMENSION), 3)

  logger.info('neural_artifact_valid', {
    candidateCount: 3,
    scoresFinite: Array.from(scores).every((value) => Number.isFinite(value)),
  })
}

main().catch((error: unknown) => {
  // Mismo criterio que `migrate.ts`: si la configuracion/el logger mismo son
  // los que fallaron, este es el unico sitio donde escribir directo se
  // justifica.
  process.stderr.write(`neural_artifact_invalid: ${describeError(error)}\n`)
  process.exitCode = 1
})
