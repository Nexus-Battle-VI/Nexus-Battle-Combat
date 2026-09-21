import type { ParticipantKind } from './Participant'

/**
 * Un participante dentro de la cola de turnos (HU-17, RF-17).
 *
 * `(teamLabel, seat)` identifica de forma unica al participante en la sala
 * (los `AI` no tienen `playerId`, asi que el asiento es lo que los distingue).
 * `heroSubtype` es una copia de PRESENTACION del subtipo canonico que publica
 * Player-Inventory al iniciar (para que Web elija el modelo visual): no se
 * copia inventario ni estadisticas.
 *
 * NO lleva `position`: la posicion es el indice en la cola y se deriva al
 * construir la vista, para no guardar dos veces el mismo dato.
 */
export interface TurnOrderEntry {
  readonly teamLabel: string
  /** Indice 0-based del participante dentro de su equipo en la sala. */
  readonly seat: number
  readonly kind: ParticipantKind
  readonly playerId: string | null
  readonly displayName: string | null
  readonly heroId: string | null
  readonly heroSubtype: string | null
}

/** Participante candidato a la cola: lo que el dominio necesita para ordenar. */
export type RosterMember = TurnOrderEntry

export interface TeamRoster {
  readonly label: string
  readonly members: readonly RosterMember[]
}

/** Identificador estable de un participante dentro de la sala. */
export const memberKey = (member: { teamLabel: string; seat: number }): string =>
  `${member.teamLabel}#${String(member.seat)}`
