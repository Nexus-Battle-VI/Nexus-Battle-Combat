import type { AiDecisionPort } from '../ports/AiDecisionPort'
import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import { NoLegalDecisionActionsError } from '../../domain/errors/DecisionContractErrors'
import {
  NeuralInferenceOutputError,
  NeuralInferenceTimeoutError,
} from '../../domain/errors/NeuralPolicyErrors'
import type { NeuralInferencePort } from '../ports/NeuralInferencePort'
import { FEATURE_DIMENSION, type FeatureEncoderV1 } from '../services/FeatureEncoderV1'

/**
 * `NeuralPolicy` (EN-036.4, Management #568 §25-27, §136, §177): adaptador de
 * `AiDecisionPort` que puntua UNICAMENTE los candidatos que Combat ya
 * declaro legales -- nunca fabrica una accion, nunca conoce `BattleRoom`,
 * Mongo, RNG ni ningun servicio externo. Solo depende de `FeatureEncoderV1`
 * (puro) y `NeuralInferencePort` (el runtime ONNX, detras de un puerto).
 *
 * Algoritmo (#568 §26): encode cada candidato por separado (preservando el
 * orden `candidateFeatures[i] -> legalActions[i]`, critico para #568 §136),
 * concatenar en un unico `Float32Array` de `C * FEATURE_DIMENSION`, UNA sola
 * llamada al runtime, argmax sobre los scores crudos, devolver la
 * `LegalAction` correspondiente como `ActionIntent` (misma forma
 * estructural, #568 §136: NUNCA se reconstruye ni se "mejora").
 *
 * Tie-break (#568 §27, decision tecnica v1 -- el issue no lo define): ante
 * un empate EXACTO, se elige el PRIMERO en el orden recibido de
 * `legalActions`. Sin RNG: misma `state`+`legalActions`+modelo siempre
 * produce la misma decision (#568 §97).
 *
 * `DecisionPolicySelector` siempre vuelve a validar con `resolveLegalAction`
 * (CA-07 de #555) y cae a `RuleBasedPolicy` ante cualquier error de aqui
 * (deshabilitada, timeout, runtime caido, output invalido): esta clase
 * nunca necesita saber que existe un fallback.
 */
export class NeuralPolicy implements AiDecisionPort {
  constructor(
    private readonly encoder: FeatureEncoderV1,
    private readonly inference: NeuralInferencePort,
    private readonly inferenceTimeoutMs: number,
  ) {}

  async decide(
    state: BattleDecisionState,
    legalActions: readonly LegalAction[],
  ): Promise<ActionIntent> {
    if (legalActions.length === 0) {
      throw new NoLegalDecisionActionsError()
    }

    const candidateCount = legalActions.length
    const matrix = new Float32Array(candidateCount * FEATURE_DIMENSION)

    for (let i = 0; i < candidateCount; i += 1) {
      // `state`/`legalActions` nunca se mutan (#568 §26, §99): `encode` es
      // puro y solo LEE; el candidato original sigue siendo el que se
      // devuelve mas abajo.
      const action = legalActions[i]
      if (action === undefined) throw new NoLegalDecisionActionsError()
      const encoded = this.encoder.encode(state, action)
      matrix.set(encoded, i * FEATURE_DIMENSION)
    }

    const scores = await this.scoreWithTimeout(matrix, candidateCount)

    if (scores.length !== candidateCount) {
      throw new NeuralInferenceOutputError(
        `El runtime devolvio ${String(scores.length)} scores, se esperaban ` +
          `${String(candidateCount)} (uno por candidato, #568 §140-141).`,
      )
    }

    let bestIndex = 0
    let bestScore = scores[0]
    if (bestScore === undefined || !Number.isFinite(bestScore)) {
      throw new NeuralInferenceOutputError('El runtime devolvio un score no finito (NaN/Inf).')
    }
    for (let i = 1; i < candidateCount; i += 1) {
      const score = scores[i]
      if (score === undefined || !Number.isFinite(score)) {
        throw new NeuralInferenceOutputError('El runtime devolvio un score no finito (NaN/Inf).')
      }
      // Estrictamente mayor: un empate EXACTO conserva el `bestIndex` ya
      // elegido (el PRIMERO en el orden recibido, #568 §27).
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }

    const selected = legalActions[bestIndex]
    if (selected === undefined) throw new NoLegalDecisionActionsError()
    return selected
  }

  /**
   * #568 §34-35: timeout configurable alrededor de la inferencia UNICAMENTE
   * (nunca del encoding ni de la carga del modelo, ya precargada). Honesto
   * con la limitacion real: si `onnxruntime-node` no expone cancelacion
   * nativa de `session.run()` (no la expone en la version auditada), el
   * timeout hace que ESTE metodo rechace y el caller caiga a
   * `RuleBasedPolicy` -- pero la inferencia nativa subyacente puede seguir
   * ejecutandose en segundo plano hasta terminar por su cuenta. Nunca se
   * afirma "se cancelo la inferencia" porque no es cierto.
   */
  private async scoreWithTimeout(
    matrix: Float32Array,
    candidateCount: number,
  ): Promise<Float32Array> {
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      return await new Promise<Float32Array>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new NeuralInferenceTimeoutError(this.inferenceTimeoutMs))
        }, this.inferenceTimeoutMs)

        this.inference.score(matrix, candidateCount).then(resolve, reject)
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
