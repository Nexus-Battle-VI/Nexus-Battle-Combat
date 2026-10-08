import type { BattleEvent } from '../../domain/entities/BattleEvent'
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
 * UNA partida completa. El Poder final NUNCA se lee de la sala `FINISHED`
 * (`BattleRoom.finish()` restaura todo el Poder, #569 §52-53): este
 * colector sigue el Poder PROPIO del actor que gasta, leyendo
 * `payload.power.after` de cada evento, exactamente como ya hace
 * `MctsSearch` para la misma limitacion (ver su comentario sobre
 * "el Poder NUNCA se lee directamente de la hoja final").
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
    for (const combatant of initialCombatants) {
      if (combatant.currentPower !== null) {
        this.powerByKey.set(
          combatantKeyString({ teamLabel: combatant.teamLabel, seat: combatant.seat }),
          combatant.currentPower,
        )
      }
    }
  }

  private sideOfTeamLabel(teamLabel: string): EvaluationSide {
    return teamLabel === this.teamLabelOfSide.A ? 'A' : 'B'
  }

  recordSystemEndTurn(): void {
    this.systemEndTurns += 1
  }

  recordDecision(side: EvaluationSide, action: LegalAction): void {
    this.decisionsBySide[side] += 1
    this.actionKindCountBySide[side][action.kind] += 1
  }

  recordEvent(event: BattleEvent): void {
    const damage = extractDamage(event)
    if (damage !== null) {
      this.damageDealtBySide[this.sideOfTeamLabel(damage.attacker.teamLabel)] += damage.amount
    }

    const heal = extractHeal(event)
    if (heal !== null) {
      this.healingDoneBySide[this.sideOfTeamLabel(heal.actor.teamLabel)] +=
        heal.amountPerTarget * heal.targets.length
    }

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
