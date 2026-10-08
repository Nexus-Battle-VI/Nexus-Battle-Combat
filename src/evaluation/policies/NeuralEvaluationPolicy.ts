import type { NeuralPolicy } from '../../application/policies/NeuralPolicy'
import {
  loadValidatedNeuralArtifact,
  type NeuralArtifactLoadOptions,
} from '../../infrastructure/ai/NeuralModelArtifactLoader'
import type { NeuralModelDescriptor } from '../../infrastructure/ai/NeuralTrainingManifestV1'
import { resolveLegalAction } from '../../domain/decision/ActionIdentity'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { EvaluationDecisionContext, EvaluationPolicy } from './EvaluationPolicy'

/**
 * Envuelve la `NeuralPolicy` REAL de #568 directamente (EN-036.5,
 * Management #569 §17-18): nunca una segunda inferencia ONNX, nunca
 * reinterpreta scores. A proposito NO pasa por `DecisionPolicySelector`:
 * ese selector caeria a `RuleBasedPolicy` ante cualquier fallo y el
 * resultado se reportaria falsamente como "Neural". Aqui, si la politica
 * neuronal falla (timeout, runtime caido, output invalido), el error se
 * propaga tal cual -- el runner del harness lo registra como
 * `NEURAL_TIMEOUT`/`NEURAL_RUNTIME_ERROR` segun el tipo exacto, nunca lo
 * esconde ni lo convierte en una "derrota" silenciosa.
 */
export class NeuralEvaluationPolicy implements EvaluationPolicy {
  readonly id = 'NEURAL' as const

  /**
   * Constructor publico (a diferencia de `NeuralModelArtifactLoader`, que
   * mantiene el suyo privado): permite inyectar un `NeuralPolicy` ya
   * construido en pruebas (con un `NeuralInferencePort` falso, sin el
   * binario nativo, mismo criterio que #568) sin pasar por la carga real
   * del artefacto. Produccion/CLI siempre usa `NeuralEvaluationPolicy.load`.
   */
  constructor(
    private readonly inner: NeuralPolicy,
    readonly modelDescriptor: NeuralModelDescriptor,
  ) {}

  /**
   * Carga y valida el artefacto con la MISMA autoridad de contrato que
   * produccion (`loadValidatedNeuralArtifact`, #569 §157-160) -- nunca un
   * segundo parser. A diferencia de `loadNeuralPrimaryPolicy`, esta
   * llamada SI lanza: si un matchup requerido incluye Neural y el
   * artefacto no es valido, el harness debe fallar antes de arrancar
   * combates (#569 §169), no saltar Neural en silencio.
   */
  static async load(options: NeuralArtifactLoadOptions): Promise<NeuralEvaluationPolicy> {
    const { policy, descriptor } = await loadValidatedNeuralArtifact(options)

    return new NeuralEvaluationPolicy(policy, descriptor)
  }

  async decide(context: EvaluationDecisionContext): Promise<LegalAction> {
    const intent = await this.inner.decide(context.state, context.legalActions)

    return resolveLegalAction(intent, context.legalActions)
  }
}
