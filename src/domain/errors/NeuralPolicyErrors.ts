import { DomainError } from './DomainError'

/**
 * Errores controlados de EN-036.4 (Management #568): cualquiera de estos hace
 * que el modelo neuronal quede `unavailable` (carga) o que `NeuralPolicy`
 * rechace la decision (inferencia) -- `DecisionPolicySelector` ya captura y
 * cae a `RuleBasedPolicy` en ambos casos. El servicio NUNCA se cae por esto.
 */

export class NeuralModelArtifactError extends DomainError {
  constructor(reason: string) {
    super(`El artefacto del modelo neuronal no se pudo leer: ${reason}`)
    this.name = 'NeuralModelArtifactError'
  }
}

export class NeuralModelSchemaMismatchError extends DomainError {
  constructor(reason: string) {
    super(`El training-manifest.json del modelo neuronal no es compatible: ${reason}`)
    this.name = 'NeuralModelSchemaMismatchError'
  }
}

export class NeuralModelHashMismatchError extends DomainError {
  constructor() {
    super(
      'El SHA-256 real de model.onnx no coincide con training-manifest.json.onnxArtifactSha256.',
    )
    this.name = 'NeuralModelHashMismatchError'
  }
}

export class NeuralRuntimeUnavailableError extends DomainError {
  constructor(reason: string) {
    super(`El runtime de inferencia ONNX no esta disponible: ${reason}`)
    this.name = 'NeuralRuntimeUnavailableError'
  }
}

export class NeuralInferenceError extends DomainError {
  constructor(reason: string) {
    super(`La inferencia del modelo neuronal fallo: ${reason}`)
    this.name = 'NeuralInferenceError'
  }
}

export class NeuralInferenceTimeoutError extends DomainError {
  constructor(timeoutMs: number) {
    super(`La inferencia del modelo neuronal supero el timeout de ${String(timeoutMs)} ms.`)
    this.name = 'NeuralInferenceTimeoutError'
  }
}

export class NeuralInferenceOutputError extends DomainError {
  constructor(reason: string) {
    super(`La salida del modelo neuronal es invalida: ${reason}`)
    this.name = 'NeuralInferenceOutputError'
  }
}
