import { DomainError } from '../errors/DomainError'
import type { ParticipantKind } from './Participant'

/**
 * Resultado unico de una batalla terminada (HU-21, contrato
 * `hu-21-battle-finish-v1`, §5). JSON puro: la sala lo persiste tal cual y
 * viaja identico en `battleFinished` y en el `snapshot`.
 *
 * NO lleva creditos ni recompensas: esos son para los consumidores (contrato
 * §9) y viajan por el puerto de notificacion, nunca por aqui.
 */

/** Causa de la finalizacion (contrato §4). La causa NO es un estado: es este campo. */
export const BattleFinishReason = {
  Elimination: 'ELIMINATION',
  Disconnection: 'DISCONNECTION',
  TimeLimit: 'TIME_LIMIT',
} as const

export type BattleFinishReason = (typeof BattleFinishReason)[keyof typeof BattleFinishReason]

const ALL_REASONS: readonly BattleFinishReason[] = [
  BattleFinishReason.Elimination,
  BattleFinishReason.Disconnection,
  BattleFinishReason.TimeLimit,
]

/** `WIN` o `NO_WINNER` (empate total, pendiente del PO). */
export const BattleOutcome = {
  Win: 'WIN',
  NoWinner: 'NO_WINNER',
} as const

export type BattleOutcome = (typeof BattleOutcome)[keyof typeof BattleOutcome]

/** Como se desempato un vencimiento global por tiempo (solo con `TIME_LIMIT` y `WIN`). */
export const TiebreakRule = {
  LifePercent: 'LIFE_PERCENT',
  AbsoluteLife: 'ABSOLUTE_LIFE',
} as const

export type TiebreakRule = (typeof TiebreakRule)[keyof typeof TiebreakRule]

/** Resultado de un participante: gano su equipo, perdio, o no hubo ganador. */
export const ParticipantResultKind = {
  Won: 'WON',
  Lost: 'LOST',
  NoWinner: 'NO_WINNER',
} as const

export type ParticipantResultKind =
  (typeof ParticipantResultKind)[keyof typeof ParticipantResultKind]

const ALL_PARTICIPANT_RESULTS: readonly ParticipantResultKind[] = [
  ParticipantResultKind.Won,
  ParticipantResultKind.Lost,
  ParticipantResultKind.NoWinner,
]

/** Posicion del participante que se desconecto (`reason: DISCONNECTION`). */
export interface DisconnectedSeat {
  readonly teamLabel: string
  readonly seat: number
}

/** Estado final de un equipo: explica el resultado (contrato §5). */
export interface TeamStanding {
  readonly teamLabel: string
  readonly remainingHealth: number
  readonly maxHealth: number
  /** Solo para mostrar (dos decimales); la decision nunca lo usa (contrato §4.3). */
  readonly lifePercent: number
  readonly eliminated: boolean
}

/** Resultado de un participante (contrato §5). */
export interface ParticipantOutcome {
  readonly teamLabel: string
  readonly seat: number
  readonly kind: ParticipantKind
  readonly playerId: string | null
  readonly displayName: string | null
  readonly heroId: string | null
  readonly result: ParticipantResultKind
}

export interface BattleResult {
  readonly reason: BattleFinishReason
  readonly outcome: BattleOutcome
  readonly winnerTeamLabel: string | null
  readonly finishedAt: string
  readonly tiebreak: TiebreakRule | null
  readonly disconnected: DisconnectedSeat | null
  /** Siempre dos equipos, en el orden de la sala. */
  readonly teams: readonly [TeamStanding, TeamStanding]
  /** En el orden de la cola de turnos. */
  readonly participants: readonly ParticipantOutcome[]
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!isPlainRecord(value)) {
    throw new DomainError(`El resultado de la batalla necesita "${field}" como objeto.`)
  }

  return value
}

const requireEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DomainError(`El campo "${field}" del resultado no es un valor reconocido.`)
  }

  return value as T
}

const requireOptionalString = (value: unknown, field: string): string | null => {
  if (value === null) {
    return null
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(`El campo "${field}" del resultado debe ser una cadena no vacia o null.`)
  }

  return value
}

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(`El campo "${field}" del resultado debe ser una cadena no vacia.`)
  }

  return value
}

const requireNonNegativeInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DomainError(`El campo "${field}" del resultado debe ser un entero no negativo.`)
  }

  return value
}

const requireLifePercent = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new DomainError(`El campo "${field}" del resultado debe ser un porcentaje entre 0 y 100.`)
  }

  return value
}

const requireIsoInstant = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DomainError(`El campo "${field}" del resultado debe ser un instante ISO valido.`)
  }

  return value
}

const parseTeamStanding = (raw: unknown, index: number): TeamStanding => {
  const team = requireRecord(raw, `teams[${String(index)}]`)
  const remainingHealth = requireNonNegativeInteger(
    team.remainingHealth,
    `teams[${String(index)}].remainingHealth`,
  )
  const maxHealth = requireNonNegativeInteger(team.maxHealth, `teams[${String(index)}].maxHealth`)

  if (remainingHealth > maxHealth) {
    throw new DomainError('La vida restante de un equipo no puede superar su vida maxima.')
  }

  if (typeof team.eliminated !== 'boolean') {
    throw new DomainError('El campo "eliminated" de un equipo debe ser booleano.')
  }

  return {
    teamLabel: requireNonEmptyString(team.teamLabel, `teams[${String(index)}].teamLabel`),
    remainingHealth,
    maxHealth,
    lifePercent: requireLifePercent(team.lifePercent, `teams[${String(index)}].lifePercent`),
    eliminated: team.eliminated,
  }
}

const parseParticipantOutcome = (raw: unknown, index: number): ParticipantOutcome => {
  const participant = requireRecord(raw, `participants[${String(index)}]`)

  return {
    teamLabel: requireNonEmptyString(
      participant.teamLabel,
      `participants[${String(index)}].teamLabel`,
    ),
    seat: requireNonNegativeInteger(participant.seat, `participants[${String(index)}].seat`),
    kind: requireEnum(participant.kind, ['HUMAN', 'AI'], `participants[${String(index)}].kind`),
    playerId: requireOptionalString(
      participant.playerId,
      `participants[${String(index)}].playerId`,
    ),
    displayName: requireOptionalString(
      participant.displayName,
      `participants[${String(index)}].displayName`,
    ),
    heroId: requireOptionalString(participant.heroId, `participants[${String(index)}].heroId`),
    result: requireEnum(
      participant.result,
      ALL_PARTICIPANT_RESULTS,
      `participants[${String(index)}].result`,
    ),
  }
}

/**
 * Valida el JSON de un resultado y lo devuelve tipado. Lanza `DomainError` ante
 * CUALQUIER incoherencia: una causa desconocida, `WIN` sin ganador, `NO_WINNER`
 * con ganador, un desempate fuera de `TIME_LIMIT` con `WIN`, una desconexion
 * sin desconectado (o al reves), equipos distintos de dos o participantes con
 * un equipo que no es de la sala.
 *
 * NO recalcula la regla de vida: la coherencia de la forma se valida aqui; que
 * el ganador sea el que correspondia a las vidas es responsabilidad de quien
 * construye el resultado (el agregado), no del validador.
 */
export const parseBattleResult = (raw: unknown): BattleResult => {
  const result = requireRecord(raw, 'result')

  const reason = requireEnum(result.reason, ALL_REASONS, 'reason')
  const outcome = requireEnum(result.outcome, ['WIN', 'NO_WINNER'], 'outcome')
  const winnerTeamLabel = requireOptionalString(result.winnerTeamLabel, 'winnerTeamLabel')
  const finishedAt = requireIsoInstant(result.finishedAt, 'finishedAt')

  if (!Array.isArray(result.teams) || result.teams.length !== 2) {
    throw new DomainError('El resultado de la batalla necesita exactamente 2 equipos.')
  }

  const teams = [
    parseTeamStanding(result.teams[0], 0),
    parseTeamStanding(result.teams[1], 1),
  ] as const
  const labels = new Set(teams.map((team) => team.teamLabel))

  if (!Array.isArray(result.participants) || result.participants.length === 0) {
    throw new DomainError('El resultado de la batalla necesita al menos un participante.')
  }

  const participants = result.participants.map((participant, index) =>
    parseParticipantOutcome(participant, index),
  )

  for (const participant of participants) {
    if (!labels.has(participant.teamLabel)) {
      throw new DomainError(
        `El participante ${participant.teamLabel}#${String(participant.seat)} no pertenece a ningun equipo del resultado.`,
      )
    }
  }

  const tiebreak =
    result.tiebreak === null
      ? null
      : requireEnum(result.tiebreak, ['LIFE_PERCENT', 'ABSOLUTE_LIFE'], 'tiebreak')

  if (tiebreak !== null && (reason !== 'TIME_LIMIT' || outcome !== 'WIN')) {
    throw new DomainError('El desempate solo existe en un vencimiento por tiempo con ganador.')
  }

  if (outcome === 'WIN') {
    if (winnerTeamLabel === null || !labels.has(winnerTeamLabel)) {
      throw new DomainError('Un resultado WIN necesita un ganador que sea uno de los equipos.')
    }
  } else if (winnerTeamLabel !== null) {
    throw new DomainError('Un resultado NO_WINNER no puede declarar ganador.')
  }

  if (outcome === 'NO_WINNER' && participants.some((p) => p.result !== 'NO_WINNER')) {
    throw new DomainError('Un resultado NO_WINNER necesita que todos sus participantes empaten.')
  }

  if (outcome === 'WIN') {
    for (const participant of participants) {
      const expected = participant.teamLabel === winnerTeamLabel ? 'WON' : 'LOST'

      if (participant.result !== expected) {
        throw new DomainError(
          `El participante ${participant.teamLabel}#${String(participant.seat)} no declara el resultado que le corresponde.`,
        )
      }
    }
  }

  const disconnected =
    result.disconnected === null ? null : parseDisconnectedSeat(result.disconnected, labels)

  if (reason === 'DISCONNECTION') {
    if (disconnected === null) {
      throw new DomainError('Una finalizacion por desconexion necesita al desconectado.')
    }

    if (disconnected.teamLabel === winnerTeamLabel) {
      throw new DomainError('El equipo del desconectado no puede ser el ganador.')
    }
  } else if (disconnected !== null) {
    throw new DomainError('Solo una finalizacion por desconexion lleva desconectado.')
  }

  return {
    reason,
    outcome,
    winnerTeamLabel,
    finishedAt,
    tiebreak,
    disconnected,
    teams,
    participants,
  }
}

const parseDisconnectedSeat = (raw: unknown, labels: ReadonlySet<string>): DisconnectedSeat => {
  const disconnected = requireRecord(raw, 'disconnected')
  const teamLabel = requireNonEmptyString(disconnected.teamLabel, 'disconnected.teamLabel')
  const seat = requireNonNegativeInteger(disconnected.seat, 'disconnected.seat')

  if (!labels.has(teamLabel)) {
    throw new DomainError('El desconectado debe pertenecer a uno de los equipos del resultado.')
  }

  return { teamLabel, seat }
}
