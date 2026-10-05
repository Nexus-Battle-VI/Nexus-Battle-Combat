import type { BattleRoom } from '../../domain/entities/BattleRoom'
import type { CombatantKey } from '../../domain/entities/Combatant'
import type { LegalAction } from '../../domain/decision/LegalAction'

/**
 * Umbral de la "regla de salud" de EN-036 (Management #555, seccion "Función
 * de utilidad v1 para JcE/Misiones"): una accion cuyo efecto principal sea
 * curacion solo entra como candidata ESTRATEGICA del teacher cuando ALGUN
 * receptor tiene `healthRatio < 0.90`. No cambia la legalidad de Combat (eso
 * lo sigue decidiendo `LegalActionGenerator` exactamente igual): una sala con
 * `b1` casi lleno de Vida sigue pudiendo curar de verdad si quiere, MCTS
 * simplemente no gasta rollouts explorando esa opcion cuando es, con
 * certeza estructural, casi nula.
 */
export const HEALING_STRATEGIC_THRESHOLD = 0.9

const healthRatioOf = (room: BattleRoom, key: CombatantKey): number | null => {
  const combatant = room.battle?.combatantFor(key)
  if (combatant?.profile == null || combatant.currentHealth === null) return null
  if (combatant.profile.maxHealth <= 0) return null
  return combatant.currentHealth / combatant.profile.maxHealth
}

const alliesOf = (room: BattleRoom, actor: CombatantKey): readonly CombatantKey[] =>
  (room.battle?.turnOrder ?? []).filter((entry) => entry.teamLabel === actor.teamLabel)

/**
 * El "efecto principal" de una habilidad/epica es, por convencion v1, su
 * PRIMER efecto declarado (orden de Catalog): es el que decide si la accion
 * es curacion (`STAT_MODIFIER` sobre `HEALING`) frente a cualquier otro uso
 * (dano directo, buff, reflejo...). La curacion EFECTIVA
 * (`min(sanacion, Vida faltante)`) no se recalcula aqui: ya la aplica
 * `HealApplicationPolicy` sobre el estado real, y el teacher evalua
 * exactamente ese estado resultante (nunca la magnitud nominal del efecto).
 */
const isPrimarilyHealing = (
  room: BattleRoom,
  actor: CombatantKey,
  action: LegalAction,
): boolean => {
  if (action.kind !== 'ABILITY' && action.kind !== 'EPIC') return false

  const profile = room.battle?.combatantFor(actor)?.profile
  if (profile == null) return false

  const effects =
    action.kind === 'ABILITY'
      ? (profile.abilities?.find((ability) => ability.abilityId === action.abilityId)?.effects ??
        [])
      : (profile.epic?.executableEffects ?? [])
  const primary = effects[0]

  return primary?.kind === 'STAT_MODIFIER' && primary.statistic === 'HEALING'
}

/** `true` si NINGUN receptor de la curacion se beneficiaria realmente (todos por encima del umbral). */
const isWastefulHeal = (room: BattleRoom, actor: CombatantKey, action: LegalAction): boolean => {
  if (action.kind !== 'ABILITY' && action.kind !== 'EPIC') return false

  const recipients: readonly CombatantKey[] =
    action.target.scope === 'COMBATANT'
      ? [action.target.combatant]
      : action.target.scope === 'ALLIED_GROUP'
        ? alliesOf(room, actor)
        : [actor] // 'SELF'

  const ratios = recipients
    .map((key) => healthRatioOf(room, key))
    .filter((ratio): ratio is number => ratio !== null)

  return ratios.length > 0 && ratios.every((ratio) => ratio >= HEALING_STRATEGIC_THRESHOLD)
}

/**
 * Filtra, de entre las acciones legales de Combat (sin tocarlas ni
 * reordenarlas), las que el teacher considera candidatas ESTRATEGICAS: toda
 * accion que no sea "principalmente curacion" pasa igual, y una de curacion
 * solo se descarta cuando TODOS sus receptores posibles ya estan por encima
 * de `HEALING_STRATEGIC_THRESHOLD` (§ "Regla de salud", EN-036 #555).
 *
 * Nunca devuelve una lista vacia si `legalActions` no lo estaba: si TODAS las
 * opciones legales fueran curaciones desperdiciadas, filtrarlas todas dejaria
 * al teacher sin nada que explorar, lo que violaria "MCTS solo expande
 * acciones legales" (CA-01 de #565) de otra forma -- se devuelven tal cual en
 * ese caso extremo en vez de vaciar la busqueda.
 */
export const filterStrategicCandidates = (
  room: BattleRoom,
  actor: CombatantKey,
  legalActions: readonly LegalAction[],
): readonly LegalAction[] => {
  const strategic = legalActions.filter(
    (action) => !(isPrimarilyHealing(room, actor, action) && isWastefulHeal(room, actor, action)),
  )

  return strategic.length > 0 ? strategic : legalActions
}
