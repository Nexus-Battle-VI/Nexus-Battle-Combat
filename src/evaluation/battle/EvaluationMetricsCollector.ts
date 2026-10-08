import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { Combatant, CombatantKey } from '../../domain/entities/Combatant'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { EvaluationSide } from '../experiment/EvaluationSeedSchedule'
import { extractDamage, extractHeal, extractPowerAfter } from './EvaluationMetricsExtraction'

const combatantKeyString = (key: CombatantKey): string => `${key.teamLabel}#${String(key.seat)}`

export interface EvaluationMatchMetrics {
  readonly damageDealtBySide: Readonly<Record<EvaluationSide, number>>
  readonly healingDoneBySide: Readonly<Record<EvaluationSide, number>>
  readonly decisionsBySide: Readonly<Record<EvaluationSide, number>>
  readonly actionKindCountBySide: Readonly<
    Record<EvaluationSide, Readonly<Record<LegalAction['kind'], number>>>
  >
  readonly systemEndTurns: number
  readonly finalPowerBySide: Readonly<Record<EvaluationSide, number | null>>
}

const zeroActionKindCount = (): Record<LegalAction['kind'], number> => ({
  BASIC_ATTACK: 0,
  ABILITY: 0,
  EPIC: 0,
})

/**
 * Observa `BattleRoom`/`BattleEvent` SIN mutarlos (EN-036.5, Management
 * #569 §105): acumula daño/curacion/Poder/acciones por lado a lo largo de
 * UNA partida completa.
 *
 * Poder (correccion de revision sobre #569: el bug historico que
 * `MctsSearch` ya habia corregido reaparecio aqui). Seguir SOLO
 * `payload.power.after` pierde la regeneracion `+2` de
 * `Combatant.openOwnTurn()`, que NINGUN evento reporta (10 -> skill ->
 * 4 -> el rival completa turno -> se abre el turno propio -> 6: el valor
 * real es 6, no 4). La semantica correcta, copiada de
 * `MctsSearch.terminalPower`/`simulateTrajectory`:
 *
 *  - Transicion NO terminal (`recordNonTerminalStep`): el Poder se
 *    SINCRONIZA desde la sala REAL resultante de ese paso
 *    (`room.battle.combatants[].currentPower`) -- ese snapshot ya
 *    incluye gasto Y regeneracion, lo haya pagado el actor que actuo o
 *    lo haya regenerado el actor al que se le abrio el turno.
 *  - Transicion TERMINAL (`recordTerminalStep`): la sala `FINISHED` ya
 *    paso por `BattleRoom.finish() -> restoreAllPower()` y NUNCA se lee.
 *    Se sincroniza desde `priorRoom` (la sala justo ANTES de esa ultima
 *    accion) y, si el evento que termino la partida trae
 *    `payload.power.after`, se ajusta SOLO el actor que lo pago.
 */
export class EvaluationMetricsCollector {
  private readonly powerByKey = new Map<string, number>()
  private readonly damageDealtBySide: Record<EvaluationSide, number> = { A: 0, B: 0 }
  private readonly healingDoneBySide: Record<EvaluationSide, number> = { A: 0, B: 0 }
  private readonly decisionsBySide: Record<EvaluationSide, number> = { A: 0, B: 0 }
  private readonly actionKindCountBySide: Record<
    EvaluationSide,
    Record<LegalAction['kind'], number>
  > = {
    A: zeroActionKindCount(),
    B: zeroActionKindCount(),
  }

  private systemEndTurns = 0

  constructor(
    private readonly teamLabelOfSide: Readonly<Record<EvaluationSide, string>>,
    initialCombatants: readonly Combatant[],
  ) {
    this.syncPowerFromCombatants(initialCombatants)
  }

  private sideOfTeamLabel(teamLabel: string): EvaluationSide {
    return teamLabel === this.teamLabelOfSide.A ? 'A' : 'B'
  }

  private syncPowerFromCombatants(combatants: readonly Combatant[]): void {
    for (const combatant of combatants) {
      if (combatant.currentPower !== null) {
        this.powerByKey.set(
          combatantKeyString({ teamLabel: combatant.teamLabel, seat: combatant.seat }),
          combatant.currentPower,
        )
      }
    }
  }

  recordSystemEndTurn(): void {
    this.systemEndTurns += 1
  }

  recordDecision(side: EvaluationSide, action: LegalAction): void {
    this.decisionsBySide[side] += 1
    this.actionKindCountBySide[side][action.kind] += 1
  }

  /** Daño/curación: independiente de si el paso fue terminal (ver `recordNonTerminalStep`/`recordTerminalStep` para Poder). */
  recordDamageAndHeal(event: BattleEvent): void {
    const damage = extractDamage(event)
    if (damage !== null) {
      this.damageDealtBySide[this.sideOfTeamLabel(damage.attacker.teamLabel)] += damage.amount
    }

    const heal = extractHeal(event)
    if (heal !== null) {
      this.healingDoneBySide[this.sideOfTeamLabel(heal.actor.teamLabel)] +=
        heal.amountPerTarget * heal.targets.length
    }
  }

  /** Paso NO terminal: sincroniza Poder desde la sala REAL resultante (gasto + regeneracion ya aplicados por el motor). */
  recordNonTerminalStep(room: BattleRoom): void {
    this.syncPowerFromCombatants(room.battle?.combatants ?? [])
  }

  /**
   * Paso TERMINAL: `room.finish()` ya ejecuto `restoreAllPower()`, asi que
   * NUNCA se lee la sala resultante. `priorRoom` es la sala justo ANTES de
   * la accion que termino la partida; si esa accion pago Poder
   * (`event.payload.power.after`), se ajusta solo ese actor.
   */
  recordTerminalStep(priorRoom: BattleRoom, event: BattleEvent): void {
    this.syncPowerFromCombatants(priorRoom.battle?.combatants ?? [])

    const power = extractPowerAfter(event)
    if (power !== null) {
      this.powerByKey.set(combatantKeyString(power.actor), power.after)
    }
  }

  snapshot(): EvaluationMatchMetrics {
    const finalPowerBySide: Record<EvaluationSide, number | null> = {
      A:
        this.powerByKey.get(combatantKeyString({ teamLabel: this.teamLabelOfSide.A, seat: 0 })) ??
        null,
      B:
        this.powerByKey.get(combatantKeyString({ teamLabel: this.teamLabelOfSide.B, seat: 0 })) ??
        null,
    }

    return {
      damageDealtBySide: { ...this.damageDealtBySide },
      healingDoneBySide: { ...this.healingDoneBySide },
      decisionsBySide: { ...this.decisionsBySide },
      actionKindCountBySide: {
        A: { ...this.actionKindCountBySide.A },
        B: { ...this.actionKindCountBySide.B },
      },
      systemEndTurns: this.systemEndTurns,
      finalPowerBySide,
    }
  }
}
