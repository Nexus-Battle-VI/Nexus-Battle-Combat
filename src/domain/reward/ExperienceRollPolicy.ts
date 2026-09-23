import type { BoundedRandom } from '../policies/TurnOrderPolicy'

/**
 * Tirada de la recompensa de experiencia por derrota de un NPC (HU-09,
 * `hu-09-experience-reward-v1` §5). Task HU-09.2.
 *
 * UNA TIRADA POR CADA NPC DERROTADO, no una por mision. Y la identidad de cada
 * derrota es la INSTANCIA -- el encuentro y el enemigo concreto --, nunca el
 * arquetipo: una mision puede enfrentar dos veces al mismo tipo
 * (`sombra-corrompida` aparece con `count: 4` y con `count: 6` en el ejemplo de
 * HU-72), y quedarse con el arquetipo perderia una de las dos recompensas.
 *
 * DE DONDE SALE LA IDENTIDAD. De la simulacion de HU-72: su `combatLog` registra
 * cada baja como `{ type: "combatantDefeated", encounter, combatant }`, donde
 * `combatant` es `<enemyRef>#<n>`. Esos dos valores llegan aqui ya resueltos.
 *
 * NO CONOCE NINGUNA FORMULA DE EXPERIENCIA. Devuelve el dado; que vale
 * `10 x 1,2^(roll)` es de Missions y Combat no lo sabe.
 *
 * Es una funcion PURA: recibe la fuente de azar ya inyectada y no guarda estado.
 * No crea ninguna secuencia propia: consume la MISMA instancia de proceso
 * (`BATTLE_RANDOM`) que alimenta los turnos, los ataques y el cofre, que es lo
 * que `ADR-021` exige de un unico generador centralizado.
 */

/** Una derrota concreta: el encuentro y la instancia del enemigo que cayo. */
export interface ExperienceRollDefeat {
  /** Indice del encuentro dentro de la mision (el `encounter` del `combatLog`). */
  readonly encounterId: string
  /** Instancia concreta del enemigo (`<enemyRef>#<n>`, el `combatant`). */
  readonly enemyInstanceId: string
  /** Arquetipo del enemigo. Viaja para trazabilidad; NO identifica la derrota. */
  readonly rivalRef: string
}

/** La derrota con su tirada. */
export interface ExperienceRoll extends ExperienceRollDefeat {
  /** Entero `1..8`. */
  readonly roll: number
}

/** Caras del dado de la recompensa: `1d8`. */
export const EXPERIENCE_ROLL_FACES = 8

/**
 * Una tirada por derrota, EN EL ORDEN RECIBIDO.
 *
 * El orden importa y no es cosmetico: las tiradas salen del mismo cursor de azar
 * que el resto del proceso, asi que el orden de consumo forma parte del
 * resultado. Mismo lote y mismo `operationId` producen las mismas tiradas en el
 * mismo orden -- y por eso el lote se persiste antes de responder, para que un
 * reintento no vuelva a consumir el cursor.
 *
 * `BoundedRandom.nextInt(8)` es uniforme sin sesgo (muestreo por rechazo) y
 * devuelve `0..7`; el `+ 1` lo lleva a `1..8`, que es el rango del dado.
 */
export const rollExperienceFor = (
  defeats: readonly ExperienceRollDefeat[],
  random: BoundedRandom,
): readonly ExperienceRoll[] =>
  defeats.map((defeat) =>
    Object.freeze({ ...defeat, roll: random.nextInt(EXPERIENCE_ROLL_FACES) + 1 }),
  )

/** Clave de una derrota: lo que la hace unica dentro de una mision. */
export const defeatKeyOf = (defeat: ExperienceRollDefeat): string =>
  `${defeat.encounterId}:${defeat.enemyInstanceId}`
