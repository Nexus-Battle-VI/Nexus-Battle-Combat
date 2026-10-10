import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ActionIntent } from '../../domain/decision/ActionIntent'
import type { BattleDecisionState } from '../../domain/decision/BattleDecisionState'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { AiDecisionPort } from '../../application/ports/AiDecisionPort'
import type { AiModelArtifactRepositoryPort } from '../../application/ports/AiModelArtifactRepositoryPort'
import type { AiModelRegistry } from '../../application/services/AiModelRegistry'
import { materializeNeuralArtifactDir } from '../evaluation/NeuralArtifactMaterializer'
import { loadValidatedNeuralArtifact } from './NeuralModelArtifactLoader'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/** En pruebas `autoStart: false` y `refresh()` se llama a mano, igual criterio que `IntervalBattleDeadlineScheduler` (HU-21). */
export interface ActiveModelProviderOptions {
  readonly enabled: boolean
  readonly autoStart: boolean
  readonly pollIntervalMs: number
  readonly nodeEnv: string
  readonly inferenceTimeoutMs: number
  readonly workRootDir: string
}

export const DEFAULT_ACTIVE_MODEL_PROVIDER_OPTIONS: Omit<
  ActiveModelProviderOptions,
  'nodeEnv' | 'inferenceTimeoutMs'
> = {
  enabled: true,
  autoStart: true,
  pollIntervalMs: 30_000,
  workRootDir: tmpdir(),
}

/**
 * Fuente productiva de verdad del modelo neuronal ACTIVE (EN-037.3,
 * Management #572 §11): resuelve `AiModelRegistry.findActive()`, lo
 * materializa (`materializeNeuralArtifactDir`, #572 §6) y lo valida con
 * la MISMA autoridad de contrato que produccion/harness
 * (`loadValidatedNeuralArtifact`, #568/#569) -- nunca un segundo
 * validador. Implementa `AiDecisionPort` directamente como un PROXY
 * delante del `NeuralPolicy` actualmente cargado, para que
 * `DecisionPolicySelector` (#558/#568) no necesite cambiar NI UNA LINEA:
 * recibe esta instancia como su `primary.policy` fija para siempre, y
 * esta clase intercambia el delegado interno en cada promocion/rollback
 * sin que `DecisionPolicySelector` lo sepa.
 *
 * Intercambio seguro (#572 §11.3): `this.current` es una referencia
 * inmutable mientras una decision esta en curso -- `refresh()` nunca
 * MUTA el `NeuralPolicy` cargado, solo REASIGNA la referencia despues de
 * validar el nuevo artefacto completo. Una decision que ya tomo su
 * referencia de `this.current` (closure local dentro de `decide()`)
 * termina con la version con la que empezo, nunca a mitad de camino.
 *
 * Fail-safe (#572 §11.5): si `refresh()` falla (ACTIVE corrupto, hash
 * incompatible, manifest invalido), NUNCA destruye `this.current` --
 * el modelo anterior (si habia uno cargado y validado) sigue sirviendo
 * decisiones hasta que una promocion/rollback VALIDA lo reemplace.
 */
export class ActiveModelProvider
  implements AiDecisionPort, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly options: ActiveModelProviderOptions
  private current: AiDecisionPort | null = null
  private currentModelVersion: string | null = null
  private currentRevision: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshInFlight = false

  constructor(
    private readonly registry: AiModelRegistry,
    private readonly artifactRepository: AiModelArtifactRepositoryPort,
    private readonly logger: Logger,
    options: ActiveModelProviderOptions,
  ) {
    this.options = options
  }

  async decide(
    state: BattleDecisionState,
    legalActions: readonly LegalAction[],
  ): Promise<ActionIntent> {
    const delegate = this.current
    if (delegate === null) {
      throw new Error('ActiveModelProvider: ningun modelo ACTIVE cargado todavia.')
    }
    // `delegate` es la referencia TOMADA al empezar esta decision (#572
    // §11.3): si `refresh()` reasigna `this.current` mientras esta
    // promesa esta pendiente, esta decision especifica sigue usando la
    // version con la que empezo, nunca una mezcla a mitad de camino.
    return delegate.decide(state, legalActions)
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.enabled) return
    await this.refresh()

    if (!this.options.autoStart) return

    this.timer = setInterval(() => {
      void this.refresh()
    }, this.options.pollIntervalMs)
    this.timer.unref()
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Resuelve el ACTIVE vigente y, si cambio (`modelVersion`/`revision`
   * distintos a lo ya cargado), lo materializa y valida ANTES de
   * intercambiar la referencia. Publico para que las pruebas lo invoquen
   * sin temporizadores reales (`autoStart: false`).
   */
  async refresh(): Promise<void> {
    if (!this.options.enabled) return
    if (this.refreshInFlight) return // nunca dos refresh concurrentes pisandose el work dir.
    this.refreshInFlight = true
    try {
      const active = await this.registry.findActive()

      if (active === null) {
        if (this.currentModelVersion !== null) {
          this.logger.warn('ai_active_model_unavailable', {
            detail:
              'El Model Registry ya no reporta ningun ACTIVE; se conserva el ultimo modelo cargado.',
          })
        }
        return
      }

      if (
        active.modelVersion === this.currentModelVersion &&
        active.revision === this.currentRevision
      ) {
        return // sin cambios: ninguna recarga de ONNX innecesaria (#572 §11.3).
      }

      const dir = await mkdtemp(join(this.options.workRootDir, 'ai-active-model-'))
      try {
        const paths = await materializeNeuralArtifactDir(this.artifactRepository, active, dir, {
          includeParityReference: false,
        })
        const { policy } = await loadValidatedNeuralArtifact({
          onnxPath: paths.onnxPath,
          manifestPath: paths.manifestPath,
          nodeEnv: this.options.nodeEnv,
          // Nunca SMOKE_TEST en produccion (#572 §11.2): `registerCandidate`
          // ya lo bloquea antes de llegar a CANDIDATE/ACTIVE, esto es
          // defensa en profundidad adicional, nunca la unica barrera.
          allowSmokeModel: false,
          inferenceTimeoutMs: this.options.inferenceTimeoutMs,
        })

        this.current = policy
        this.currentModelVersion = active.modelVersion
        this.currentRevision = active.revision
        this.logger.info('ai_active_model_loaded', {
          modelVersion: active.modelVersion,
          revision: active.revision,
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    } catch (error: unknown) {
      this.logger.error('ai_model_activation_failed', { reason: describeError(error) })
      // Nunca tocar `this.current` aqui (#572 §11.5): un ACTIVE invalido
      // nunca reemplaza silenciosamente un modelo anterior que si cargo.
    } finally {
      this.refreshInFlight = false
    }
  }
}
