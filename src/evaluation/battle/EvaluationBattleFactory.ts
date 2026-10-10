import { createHash } from 'node:crypto'
import { BattleRoom } from '../../domain/entities/BattleRoom'
import { Combatant } from '../../domain/entities/Combatant'
import type { CombatProfile } from '../../domain/entities/CombatProfile'
import { createBoundedRandom } from '../../application/services/BoundedRandom'
import type { RandomSequencePort } from '../../application/ports/RandomSequencePort'
import { generateTurnOrder } from '../../domain/policies/TurnOrderPolicy'

/** Decision tecnica v1 (#569 §38): 1v1, etiquetas de equipo fijas para todo el harness. */
export const EVALUATION_TEAM_A_LABEL = 'A'
export const EVALUATION_TEAM_B_LABEL = 'B'
export const EVALUATION_TEAM_A_PLAYER_ID = 'evaluation-a1'
export const EVALUATION_TEAM_B_PLAYER_ID = 'evaluation-b1'

export interface BuildEvaluationBattleRoomOptions {
  /** Material determinista (p. ej. el `matchId`) para derivar el UUID v4 de la sala. */
  readonly roomIdSeed: string
  readonly teamAProfile: CombatProfile
  readonly teamBProfile: CombatProfile
  /** Semilla SEPARADA del Combat RNG de la partida (#569 §29, §41: "semilla separada"). */
  readonly turnOrderSequence: RandomSequencePort
  readonly at: Date
}

/**
 * `BattleRoom.id` exige un UUID v4 real (HU-14, `BattleRoomId`): deriva uno
 * DETERMINISTA a partir de `roomIdSeed` via SHA-256 (nunca
 * `crypto.randomUUID()`, que romperia la reproducibilidad del harness por
 * una identidad que ni siquiera se usa en ningun calculo de juego) --
 * mismo criterio que `EvaluationSeedSchedule.ts` para derivar semillas sin
 * RNG real.
 */
export const deriveEvaluationRoomId = (roomIdSeed: string): string => {
  const hex = createHash('sha256').update(roomIdSeed, 'utf8').digest('hex')
  const variantNibble = '89ab'[parseInt(hex[16] ?? '0', 16) % 4] ?? '8'

  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  )
}

/**
 * Construye una `BattleRoom` 1v1 legal `IN_BATTLE` usando SOLO APIs reales
 * de dominio (EN-036.5, Management #569 §40: "El BattleRoom inicial debe
 * ser legal", nunca un snapshot fabricado a mano): `create` + `join` x2 +
 * `generateTurnOrder` (semilla propia, nunca reutiliza el Combat RNG de la
 * partida) + `Combatant.start` + `startBattle`. Sin apuesta
 * (`reward.amount = 0`, modo `PVE`): la evaluacion nunca toca Wallet ni
 * economia (#569 §39, §104).
 */
export const buildEvaluationBattleRoom = (
  options: BuildEvaluationBattleRoomOptions,
): BattleRoom => {
  let room = BattleRoom.create(
    deriveEvaluationRoomId(options.roomIdSeed),
    EVALUATION_TEAM_A_PLAYER_ID,
    {
      mode: 'PVE',
      teamConfigs: [{ capacity: 1 }, { capacity: 1 }],
      reward: { amount: 0 },
    },
    options.at,
  )

  room = room.join(
    EVALUATION_TEAM_A_PLAYER_ID,
    EVALUATION_TEAM_A_LABEL,
    options.at,
    'Evaluation A',
    options.teamAProfile.heroId,
    1,
  )
  room = room.join(
    EVALUATION_TEAM_B_PLAYER_ID,
    EVALUATION_TEAM_B_LABEL,
    options.at,
    'Evaluation B',
    options.teamBProfile.heroId,
    1,
  )

  const [first, second] = room.roster()
  const [teamA, teamB] = first.label === EVALUATION_TEAM_A_LABEL ? [first, second] : [second, first]

  const order = generateTurnOrder([teamA, teamB], createBoundedRandom(options.turnOrderSequence))

  const combatants = order.map((entry) =>
    Combatant.start(
      entry,
      entry.teamLabel === EVALUATION_TEAM_A_LABEL ? options.teamAProfile : options.teamBProfile,
    ),
  )

  return room.startBattle(order, options.at, combatants)
}
