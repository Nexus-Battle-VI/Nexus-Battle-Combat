/**
 * Puerto de inferencia (EN-036.4, Management #568 §21): aisla `NeuralPolicy`
 * del runtime ONNX concreto. Permite probar la politica con un fake sin
 * depender del binario nativo (#568 §102), y mantiene `onnxruntime-node`
 * fuera de la capa de aplicacion.
 */
export interface NeuralInferencePort {
  /**
   * `candidateFeatures`: `candidateCount * FEATURE_DIMENSION` floats
   * concatenados en orden (candidato 0 primero, #568 §138). Devuelve
   * EXACTAMENTE `candidateCount` scores crudos, en el MISMO orden -- nunca
   * softmax, nunca una probabilidad (#568 §94-95).
   */
  score(candidateFeatures: Float32Array, candidateCount: number): Promise<Float32Array>
}
