import type { BattleEvent } from '../../domain/entities/BattleEvent'
import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { LegalAction } from '../../domain/decision/LegalAction'
import type { RandomSequencePort } from './RandomSequencePort'

export interface MctsSimulationStepResult {
  /** La sala resultante tras el paso, SIEMPRE un clon aislado; nunca la sala real de produccion. */
  readonly room: BattleRoom
  /** `true` si ese paso dejo la sala `FINISHED` (fin de la simulacion para esa rama). */
  readonly finished: boolean
  /**
   * El evento que el motor real persistio para este paso. `MctsSearch` lo usa
   * SOLO para leer `payload.power.before/after` cuando existe (habilidad o
   * epica): es la unica forma de conocer el Poder del actor justo antes de
   * que `BattleRoom.finish()` lo restaure (HU-11), ya que una sala `FINISHED`
   * nunca vuelve a exponer ese valor intermedio.
   */
  readonly event: BattleEvent
}

/**
 * Puerto de salida (EN-036.1, Management Task #565, §17-§21) que expone, para
 * uso EXCLUSIVO de herramientas de simulacion/teacher internas, el mismo
 * motor autoritativo de Combat (`ExecuteBasicAttack`/`UseSkill`/`UseEpic`/
 * `CompleteBattleTurn`) aplicado sobre un clon de sala totalmente aislado, con
 * una secuencia aleatoria propia que NUNCA es la del stream productivo
 * (`BATTLE_RANDOM_SEQUENCE`).
 *
 * NO es una ruta HTTP/WS/cron: solo `MctsSearch` la invoca. La capa de
 * aplicacion no puede importar adaptadores/infraestructura directamente
 * (`eslint.config.mjs`), de ahi que este puerto exista: su implementacion
 * (que SI construye repositorios/relojes/casos de uso concretos) vive en
 * `src/adapters/outbound/system/`.
 */
export interface MctsSimulationPort {
  /**
   * Aplica UNA accion legal ya resuelta (`BASIC_ATTACK`/`ABILITY`/`EPIC`)
   * sobre un clon de `room`, usando `sequence` para cualquier sorteo que la
   * accion necesite. `room` nunca se muta: se devuelve un clon nuevo.
   */
  applyAction(
    room: BattleRoom,
    actor: CombatantKey,
    action: LegalAction,
    commandId: string,
    sequence: RandomSequencePort,
  ): Promise<MctsSimulationStepResult>

  /**
   * Cierra el turno vigente de un clon de `room` sin accion (HU-17,
   * `CompleteBattleTurn`), identico al camino que Combat usa cuando
   * `legalActions = []`. No consume ningun sorteo.
   */
  applyEndTurn(room: BattleRoom, commandId: string): Promise<MctsSimulationStepResult>
}

export const MCTS_SIMULATION_PORT = Symbol('MctsSimulationPort')
