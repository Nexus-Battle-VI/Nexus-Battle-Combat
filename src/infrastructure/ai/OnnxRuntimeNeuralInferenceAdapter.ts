import type * as OnnxRuntimeNode from 'onnxruntime-node'
import type { InferenceSession } from 'onnxruntime-node'
import type { NeuralInferencePort } from '../../application/ports/NeuralInferencePort'
import { FEATURE_DIMENSION } from '../../application/services/FeatureEncoderV1'
import {
  NeuralInferenceError,
  NeuralInferenceOutputError,
  NeuralRuntimeUnavailableError,
} from '../../domain/errors/NeuralPolicyErrors'
import { describeError } from '../observability/describe-error'
import { NEURAL_ONNX_INPUT_NAME, NEURAL_ONNX_OUTPUT_NAME } from './NeuralTrainingManifestV1'

type OnnxRuntimeModule = typeof OnnxRuntimeNode

/**
 * Validacion del output real de `session.run()` (#568 §60, §92-93,
 * §140-143), extraida como funcion PURA para poder probarla con un
 * `InferenceSession.ReturnType` fabricado -- sin depender del binario
 * nativo en las pruebas unitarias. `OnnxRuntimeNeuralInferenceAdapter.score`
 * es el UNICO caller real; la prueba de integracion real (#568 §61) ejercita
 * el camino completo contra el runtime autentico.
 */
export const validateOnnxOutput = (
  results: InferenceSession.ReturnType,
  candidateCount: number,
): Float32Array => {
  const output = results[NEURAL_ONNX_OUTPUT_NAME]
  if (output === undefined) {
    throw new NeuralInferenceOutputError(
      `Falta el output "${NEURAL_ONNX_OUTPUT_NAME}" en la respuesta.`,
    )
  }
  // #568 §92: no coercionar Float64 en silencio -- el contrato congelado
  // por #567 es float32 explicito.
  if (output.type !== 'float32') {
    throw new NeuralInferenceOutputError(
      `El output es de tipo "${output.type}", se esperaba "float32".`,
    )
  }
  // #568 §93: el contrato congelado devuelve rank 1 ([C]), nunca [C,1].
  if (output.dims.length !== 1 || output.dims[0] !== candidateCount) {
    throw new NeuralInferenceOutputError(
      `El output tiene shape ${JSON.stringify(output.dims)}, se esperaba [${String(candidateCount)}].`,
    )
  }

  const scores = Float32Array.from(output.data as ArrayLike<number>)
  // #568 §140-141: ni vacio ni con mas/menos posiciones que candidatos.
  if (scores.length !== candidateCount) {
    throw new NeuralInferenceOutputError(
      `El output tiene ${String(scores.length)} valores, se esperaban ${String(candidateCount)}.`,
    )
  }
  for (const value of scores) {
    // #568 §142-143: NaN/+-Inf es un fallo controlado, nunca una eleccion
    // silenciosa de otro candidato.
    if (!Number.isFinite(value)) {
      throw new NeuralInferenceOutputError('El output contiene NaN/Inf.')
    }
  }
  return scores
}

/**
 * Adapter de infraestructura (EN-036.4, Management #568 §22-24): UNA
 * `InferenceSession` singleton por proceso (nunca una por decision, #568
 * §49), CPU-only (#568 §24: `executionProviders: ['cpu']`, el unico
 * provider auditado contra la version real instalada -- sin GPU/CUDA/
 * DirectML/CoreML).
 *
 * `onnxruntime-node` se importa con `import()` DINAMICO (#568 §23), nunca
 * `import ... from 'onnxruntime-node'` estatico: asi, si el binario nativo
 * es incompatible con la plataforma real (musl/glibc, arquitectura), el
 * fallo se captura aqui como `NeuralRuntimeUnavailableError` controlado, en
 * vez de reventar el bootstrap de Nest con un `require()` que ya fallo al
 * cargar el modulo.
 */
export class OnnxRuntimeNeuralInferenceAdapter implements NeuralInferencePort {
  private constructor(
    private readonly ort: OnnxRuntimeModule,
    private readonly session: InferenceSession,
  ) {}

  /**
   * Crea la sesion Y ejecuta un smoke real de `[1, FEATURE_DIMENSION]` antes
   * de devolver el adapter (#568 §44): `InferenceSession.create()` resolver
   * no demuestra que el modelo realmente infiere.
   */
  static async create(modelPath: string): Promise<OnnxRuntimeNeuralInferenceAdapter> {
    let ort: OnnxRuntimeModule
    try {
      ort = await import('onnxruntime-node')
    } catch (error) {
      throw new NeuralRuntimeUnavailableError(describeError(error))
    }

    let session: InferenceSession
    try {
      session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
    } catch (error) {
      throw new NeuralRuntimeUnavailableError(describeError(error))
    }

    if (
      !session.inputNames.includes(NEURAL_ONNX_INPUT_NAME) ||
      !session.outputNames.includes(NEURAL_ONNX_OUTPUT_NAME)
    ) {
      throw new NeuralRuntimeUnavailableError(
        `La sesion real no expone los nombres esperados (input="${NEURAL_ONNX_INPUT_NAME}", ` +
          `output="${NEURAL_ONNX_OUTPUT_NAME}"); inputNames=${JSON.stringify(session.inputNames)} ` +
          `outputNames=${JSON.stringify(session.outputNames)}.`,
      )
    }

    const adapter = new OnnxRuntimeNeuralInferenceAdapter(ort, session)

    try {
      await adapter.score(new Float32Array(FEATURE_DIMENSION), 1)
    } catch (error) {
      throw new NeuralRuntimeUnavailableError(
        `El smoke de inferencia real [1,${String(FEATURE_DIMENSION)}] fallo: ${describeError(error)}`,
      )
    }

    return adapter
  }

  async score(candidateFeatures: Float32Array, candidateCount: number): Promise<Float32Array> {
    const tensor = new this.ort.Tensor('float32', candidateFeatures, [
      candidateCount,
      FEATURE_DIMENSION,
    ])

    let results: InferenceSession.ReturnType
    try {
      results = await this.session.run({ [NEURAL_ONNX_INPUT_NAME]: tensor })
    } catch (error) {
      throw new NeuralInferenceError(describeError(error))
    }

    return validateOnnxOutput(results, candidateCount)
  }
}
