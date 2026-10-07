import type { InferenceSession } from 'onnxruntime-node'
import { validateOnnxOutput } from '../../src/infrastructure/ai/OnnxRuntimeNeuralInferenceAdapter'
import { NeuralInferenceOutputError } from '../../src/domain/errors/NeuralPolicyErrors'

/**
 * `validateOnnxOutput` (EN-036.4, Management #568 §60): fabrica un
 * `InferenceSession.ReturnType` -- NUNCA depende del binario nativo real.
 * La prueba de integracion real contra el runtime autentico vive en
 * `test/integration/onnx-runtime-neural-inference-real.spec.ts` (#568 §61,
 * §103).
 */
const fakeResult = (overrides: {
  readonly type?: string
  readonly dims?: readonly number[]
  readonly data?: ArrayLike<number>
}): InferenceSession.ReturnType =>
  ({
    scores: {
      type: overrides.type ?? 'float32',
      dims: overrides.dims ?? [2],
      data: overrides.data ?? Float32Array.from([0.1, 0.2]),
    },
  }) as unknown as InferenceSession.ReturnType

describe('validateOnnxOutput (EN-036.4, Management #568 §92-93, §140-143)', () => {
  it('acepta un output valido: nombre, dtype, shape y valores finitos correctos', () => {
    const result = fakeResult({ data: Float32Array.from([0.3, 0.7]) })
    const scores = validateOnnxOutput(result, 2)
    expect(Array.from(scores)).toEqual([0.30000001192092896, 0.699999988079071])
  })

  it('rechaza cuando falta el output "scores"', () => {
    const result = {
      somethingElse: { type: 'float32', dims: [1], data: [0.1] },
    } as unknown as InferenceSession.ReturnType
    expect(() => validateOnnxOutput(result, 1)).toThrow(NeuralInferenceOutputError)
  })

  it('#568 §92: rechaza un dtype distinto de float32 (nunca coercionar en silencio)', () => {
    const result = fakeResult({ type: 'float64', data: Float64Array.from([0.1, 0.2]) })
    expect(() => validateOnnxOutput(result, 2)).toThrow(NeuralInferenceOutputError)
  })

  it('#568 §93: rechaza un shape [C,1] cuando se esperaba rank 1 [C]', () => {
    const result = fakeResult({ dims: [2, 1] })
    expect(() => validateOnnxOutput(result, 2)).toThrow(NeuralInferenceOutputError)
  })

  it('#568 §141: rechaza cuando el output trae mas scores que candidatos (nunca truncar)', () => {
    const result = fakeResult({ dims: [3], data: Float32Array.from([0.1, 0.2, 0.3]) })
    expect(() => validateOnnxOutput(result, 2)).toThrow(NeuralInferenceOutputError)
  })

  it('#568 §140: rechaza un output vacio', () => {
    const result = fakeResult({ dims: [0], data: Float32Array.from([]) })
    expect(() => validateOnnxOutput(result, 2)).toThrow(NeuralInferenceOutputError)
  })

  it('#568 §142: rechaza NaN', () => {
    const result = fakeResult({ data: Float32Array.from([0.1, Number.NaN]) })
    expect(() => validateOnnxOutput(result, 2)).toThrow(NeuralInferenceOutputError)
  })

  it('#568 §143: rechaza +-Infinity', () => {
    const result = fakeResult({ data: Float32Array.from([Number.POSITIVE_INFINITY, 0.1]) })
    expect(() => validateOnnxOutput(result, 2)).toThrow(NeuralInferenceOutputError)
  })
})
