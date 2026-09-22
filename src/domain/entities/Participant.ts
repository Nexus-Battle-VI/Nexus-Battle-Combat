import { DomainError } from '../errors/DomainError'
import {
  createParticipantStake,
  type ParticipantStake,
  type ParticipantStakeInput,
} from '../value-objects/ParticipantStake'

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
 *
 * ACTUALIZADO EN HU-16 (RF-16, Management#25/#401/#402): Combat SI consulta
 * ahora Player-Inventory para decidir elegibilidad precombate
 * (`PrecombatEligibilityPolicy`) antes de aceptar la union, aunque sigue sin
 * VALIDAR EQUIPAMIENTO por su cuenta (esa autoridad permanece en
 * Player-Inventory, DP-1 de la auditoria HU-16.1).
 */
export interface Participant {
  readonly kind: ParticipantKind
  /** Obligatorio para `HUMAN` (viene del JWT verificado). `null` para `AI`. */
  readonly playerId: string | null
  /** Opcional para ambos tipos. No se modela `difficulty`/`archetype` para `AI`. */
  readonly heroId: string | null
  /**
   * Version de `HeroLoadout` (Player-Inventory) EN EL MOMENTO de unirse
   * (HU-16.2, DP-6 de la auditoria HU-16.1). `null` para `AI` y para
   * `HUMAN` sin `heroId` resuelto (no deberia ocurrir en el flujo real de
   * `JoinBattleRoom`, que siempre resuelve un heroe equipado antes de
   * llamar `join()`, pero el campo es opcional en la firma por el MISMO
   * criterio de retrocompatibilidad que `displayName`).
   *
   * PROPOSITO: referencia VERIFICABLE de la configuracion de equipamiento
   * aprobada al unirse, sin copiar el inventario (mismo criterio que
   * `heroId`: una referencia, no una copia). Permite detectar mas tarde que
   * el jugador cambio su equipamiento DESPUES de validarse (TOCTOU) si se
   * revalida contra `HeroLoadout.version` en un punto futuro del ciclo de
   * vida de la sala -- HOY no existe ese punto de revalidacion (no hay
   * transicion de "inicio de combate" mas alla de WAITING_FOR_PLAYERS ->
   * PREPARING, que es automatica por cupo): este campo CAPTURA la
   * configuracion aprobada, la revalidacion queda para cuando exista un
   * motor de combate real (ver `docs/hu-16-precombat-eligibility.md`).
   */
  readonly heroLoadoutVersion: number | null
  /**
   * Snapshot del nombre visible en el momento de unirse (HU-15.2, RF-15,
   * DP-2). Resuelto SIEMPRE por `JoinBattleRoom` desde el contrato interno
   * de Account (`GET /internal/accounts/:subject/battle-profile`), nunca del
   * cuerpo de la peticion -- mismo criterio que `heroId`. `null` para
   * participantes `AI` y para `HUMAN` creados antes de esta version (HU-14,
   * `initialParticipants` al crear la sala, que no resuelve Account) --
   * campo aditivo y retrocompatible, no una migracion destructiva.
   */
  readonly displayName: string | null
  /**
   * HU-23 (RF-23): apuesta de creditos del participante. AUSENTE cuando no
   * aposto (`0`/sin `stake`), mismo criterio aditivo que `BattleView.deadlines?`
   * de HU-21 -- nunca `null`, para no cambiar la forma de las salas sin
   * apuesta. Un `AI` nunca lo lleva (D4).
   */
  readonly stake?: ParticipantStake
  readonly joinedAt: Date
}

export interface ParticipantInput {
  readonly kind: string
  readonly playerId?: string | null
  readonly heroId?: string | null
  readonly heroLoadoutVersion?: number | null
  readonly displayName?: string | null
  /** HU-23: monto y `holdOperationId` determinista de la reserva. */
  readonly stake?: ParticipantStakeInput
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
  const heroLoadoutVersion = normalizeVersion(input.heroLoadoutVersion)
  const displayName = normalizeOptional(input.displayName)
  const joinedAt = input.joinedAt ?? at
  const stake = normalizeStake(input)

  if (Number.isNaN(joinedAt.getTime())) {
    throw new DomainError('La fecha de incorporacion del participante no es valida.')
  }

  if (input.kind === ParticipantKind.Human) {
    const playerId = normalizeOptional(input.playerId)

    if (playerId === null) {
      throw new DomainError('Un participante HUMAN necesita un jugador.')
    }

    return {
      kind: ParticipantKind.Human,
      playerId,
      heroId,
      heroLoadoutVersion,
      displayName,
      ...(stake === null ? {} : { stake }),
      joinedAt,
    }
  }

  if (normalizeOptional(input.playerId) !== null) {
    throw new DomainError('Un participante AI no lleva jugador.')
  }

  return {
    kind: ParticipantKind.Ai,
    playerId: null,
    heroId,
    heroLoadoutVersion,
    displayName,
    joinedAt,
  }
}

/** `null` cuando no hay apuesta o el monto es `0` (D5: `0` = no apostar). */
const normalizeStake = (input: ParticipantInput): ParticipantStake | null => {
  if (input.stake === undefined) {
    return null
  }

  return createParticipantStake(input.stake)
}

const normalizeOptional = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null
  }

  const trimmed = value.trim()

  return trimmed.length === 0 ? null : trimmed
}

/**
 * Estructural (`DomainError`), no una regla de negocio: la version del
 * loadout ya fue validada como entero no negativo por
 * `PlayerInventoryHttpClient` al leerla de Player-Inventory; esta
 * comprobacion es defensa en profundidad contra datos malformados que
 * lleguen por otra via (p. ej. restaurar un documento corrupto).
 */
const normalizeVersion = (value: number | null | undefined): number | null => {
  if (value === undefined || value === null) {
    return null
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError('La version del loadout del heroe debe ser un entero no negativo.')
  }

  return value
}
