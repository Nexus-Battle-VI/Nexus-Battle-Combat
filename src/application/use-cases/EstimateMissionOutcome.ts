import { evaluateMissionAbility } from '../../domain/policies/MissionAbilityPolicy'
import type { MissionSeedPort } from '../ports/MissionSeedPort'
import type { RandomSequenceFactoryPort } from '../ports/RandomSequencePort'
import { simulateMission, type MissionSimulationRequest } from '../services/MissionSimulation'

export const DEFAULT_ESTIMATE_RUNS = 30
export const MAX_ESTIMATE_RUNS = 100

/** Si una habilidad del heroe se puede usar en misiones, y por que no. */
export interface MissionAbilityCheck {
  readonly abilityId: string
  readonly name: string
  readonly usable: boolean
  readonly reason: string | null
}

export interface MissionEstimate {
  readonly runs: number
  readonly victories: number
  readonly defeats: number
  readonly timeouts: number
  /** Victorias sobre corridas, entre 0 y 1, con dos decimales. */
  readonly winRate: number
  readonly averageTurns: number
  readonly averageDamageTaken: number
  readonly averageMinHealthPercent: number
  /** Corridas en que aparecio algun Master, entre 0 y 1, con dos decimales. */
  readonly masterAppearanceRate: number
  readonly abilities: readonly MissionAbilityCheck[]
}

const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0)
const twoDecimals = (value: number): number => Math.round(value * 100) / 100

/**
 * Estimacion de la probabilidad de exito antes de matricular (diseno «misiones
 * jugables», P-J7). Corre la MISMA simulacion con `runs` semillas derivadas de la
 * operacion y no guarda nada: es una muestra, no la mision. La semilla de cada
 * corrida sale de `<operationId>:estimate:<n>`, asi que la misma solicitud da la
 * misma estimacion, y ninguna coincide con la semilla de una simulacion real.
 */
export class EstimateMissionOutcome {
  constructor(
    private readonly sequences: RandomSequenceFactoryPort,
    private readonly seeds: MissionSeedPort,
  ) {}

  execute(request: MissionSimulationRequest, runs: number): MissionEstimate {
    let victories = 0
    let defeats = 0
    let timeouts = 0
    let turns = 0
    let damageTaken = 0
    let minHealthPercent = 0
    let masterAppearances = 0

    for (let run = 1; run <= runs; run += 1) {
      const seed = this.seeds.forOperation(`${request.operationId}:estimate:${String(run)}`)
      const result = simulateMission(request, seed, this.sequences)
      if (result.combatOutcome === 'HERO_VICTORIOUS') victories += 1
      else if (result.combatOutcome === 'HERO_DEFEATED') defeats += 1
      else timeouts += 1
      turns += numberOf(result.summary.totalTurns)
      damageTaken += numberOf(result.summary.damageTaken)
      minHealthPercent += numberOf(result.summary.minHealthPercent)
      const master = result.summary.master as { readonly appeared?: unknown } | undefined
      if (master?.appeared === true) masterAppearances += 1
    }

    return {
      runs,
      victories,
      defeats,
      timeouts,
      winRate: twoDecimals(victories / runs),
      averageTurns: twoDecimals(turns / runs),
      averageDamageTaken: twoDecimals(damageTaken / runs),
      averageMinHealthPercent: twoDecimals(minHealthPercent / runs),
      masterAppearanceRate: twoDecimals(masterAppearances / runs),
      abilities: request.hero.profile.abilities.map((ability) => {
        const support = evaluateMissionAbility(ability)
        return {
          abilityId: ability.abilityId,
          name: ability.name,
          usable: support.supported,
          reason: support.supported ? null : support.reason,
        }
      }),
    }
  }
}
