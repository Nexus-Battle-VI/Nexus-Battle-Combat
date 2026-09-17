import { DomainError } from '../errors/DomainError'

/**
 * Composicion humano/IA de un puesto ocupado en un equipo (RF-14: "si se
 * admite un heroe controlado por IA").
 *
 * UN UNICO TIPO CON DISCRIMINADOR, no una jerarquia de clases: el resto del
 * dominio del proyecto usa uniones discriminadas para variantes de un mismo
 * concepto, y evita que HU-15 maneje dos tipos de retorno al leer la sala —
 * HU-14.1, `HU-14.1-Decisiones-Tecnicas.md`, punto 11.
 */
export const ParticipantKind = {
  Human: 'HUMAN',
  Ai: 'AI',
} as const

export type ParticipantKind = (typeof ParticipantKind)[keyof typeof ParticipantKind]

/**
 * `playerId` y `heroId` son referencias opacas (string), NUNCA objetos
 * copiados del perfil o del equipamiento real — mismo criterio que
 * `HeroSelection.ts` de Player-Inventory: "ES UNA SELECCION, NO UNA COPIA".
 * Combat no consulta Player-Inventory ni valida equipamiento (HU-16).
 */
export interface Participant {
  readonly kind: ParticipantKind
  /** Obligatorio para `HUMAN` (viene del JWT verificado). `null` para `AI`. */
  readonly playerId: string | null
  /** Opcional para ambos tipos. No se modela `difficulty`/`archetype` para `AI`. */
  readonly heroId: string | null
  readonly joinedAt: Date
}

export interface ParticipantInput {
  readonly kind: string
  readonly playerId?: string | null
  readonly heroId?: string | null
  /** Cuando se restaura desde persistencia, la fecha guardada. */
  readonly joinedAt?: Date
}

/**
 * Construye y valida un participante. Errores puramente estructurales
 * (tipo desconocido, `playerId` ausente en `HUMAN`, `playerId` presente en
 * `AI`) son `DomainError` (400): son datos malformados, no una regla de
 * negocio incumplida.
 *
 * `at` es la fecha a usar cuando `input.joinedAt` no viene dado (creacion).
 * Al restaurar desde persistencia se pasa `input.joinedAt` con la fecha
 * guardada, que prevalece.
 */
export const createParticipant = (input: ParticipantInput, at: Date): Participant => {
  if (input.kind !== ParticipantKind.Human && input.kind !== ParticipantKind.Ai) {
    throw new DomainError(`El tipo de participante "${input.kind}" no es reconocido.`)
  }

  const heroId = normalizeOptional(input.heroId)
  const joinedAt = input.joinedAt ?? at

  if (Number.isNaN(joinedAt.getTime())) {
    throw new DomainError('La fecha de incorporacion del participante no es valida.')
  }

  if (input.kind === ParticipantKind.Human) {
    const playerId = normalizeOptional(input.playerId)

    if (playerId === null) {
      throw new DomainError('Un participante HUMAN necesita un jugador.')
    }

    return { kind: ParticipantKind.Human, playerId, heroId, joinedAt }
  }

  if (normalizeOptional(input.playerId) !== null) {
    throw new DomainError('Un participante AI no lleva jugador.')
  }

  return { kind: ParticipantKind.Ai, playerId: null, heroId, joinedAt }
}

const normalizeOptional = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null
  }

  const trimmed = value.trim()

  return trimmed.length === 0 ? null : trimmed
}
