import { Int32 } from 'mongodb'

import type { BattleRoomSnapshot } from '../../../domain/entities/BattleRoom'
import { parseBattleResult } from '../../../domain/entities/BattleResult'
import type { BattleEvent, HandledCommand } from '../../../domain/entities/BattleEvent'
import type { BattleStateSnapshot } from '../../../domain/entities/BattleState'
import type { CombatantSnapshot } from '../../../domain/entities/Combatant'
import type { TeamSnapshot } from '../../../domain/entities/Team'
import type { TurnOrderEntry } from '../../../domain/entities/TurnOrder'

/**
 * Traduccion entre el documento de MongoDB y la instantanea de la sala de
 * batalla (HU-14). Pura y aparte del repositorio, igual que
 * `hero-selection-mapping.ts` de Player-Inventory: es donde se puede uno
 * equivocar de verdad, y aqui se prueba sin contenedor.
 */
export class BattleRoomMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BattleRoomMappingError'
  }
}

export interface ParticipantDocument {
  readonly kind: string
  readonly playerId: string | null
  readonly heroId: string | null
  /**
   * Aditivo (HU-15.2, migracion 003): documentos escritos antes de esta
   * version no lo tienen. `toSnapshot` lo trata como `undefined ->
   * null`, igual que ya hace con `heroId`/`playerId` ausentes -- ningun
   * documento existente necesita reescribirse.
   */
  readonly displayName?: string | null
  /**
   * Aditivo (HU-16.2, migracion 004, DP-6 de la auditoria HU-16.1):
   * documentos escritos antes de esta version no lo tienen. MISMO criterio
   * que `displayName`: `toSnapshot` lo trata como `undefined -> null`, sin
   * backfill.
   */
  readonly heroLoadoutVersion?: number | null
  readonly joinedAt: Date
}

export interface TeamDocument {
  readonly label: string
  readonly capacity: Int32 | number
  readonly participants: readonly ParticipantDocument[]
}

export interface RewardDocument {
  readonly amount: number
}

/**
 * HU-17 (migracion 005): estado de la batalla, bitacora de eventos y comandos
 * procesados, en el MISMO documento de la sala. Aditivos y opcionales:
 * documentos anteriores no los tienen y se restauran como "sin batalla".
 */
export interface BattleDocument {
  readonly startedAt: Date
  /**
   * HU-21 (migracion 009): inicio del turno vigente. Aditivo y opcional: una
   * batalla anterior a HU-21 no lo tiene y su turno se considera iniciado en
   * `startedAt`; no hay backfill.
   */
  readonly turnStartedAt?: Date
  readonly turnOrder: readonly TurnOrderEntry[]
  readonly turnsCompleted: Int32 | number
  /**
   * HU-18 (migracion 007): snapshot de combate y Vida actual por participante.
   * Aditivo y opcional: una batalla anterior a HU-18 no lo tiene y se restaura sin
   * Vida (no admite ataque); no hay backfill ni consulta a Player-Inventory.
   */
  readonly combatants?: readonly CombatantSnapshot[] | null
}

export interface BattleEventDocument {
  readonly seq: Int32 | number
  readonly type: string
  readonly occurredAt: Date
  /** JSON puro: la vista de la batalla ya calculada en el momento del evento. */
  readonly payload: Readonly<Record<string, unknown>>
}

export interface HandledCommandDocument {
  readonly commandId: string
  readonly seq: Int32 | number
}

/**
 * `_id` es el identificador de la sala (UUID v4 generado por el servidor),
 * igual que `hero-loadouts`/`hero-selections` usan su propia clave como
 * `_id` en lugar de un `ObjectId` autogenerado.
 */
export interface BattleRoomDocument {
  readonly _id: string
  readonly mode: string
  readonly status: string
  readonly teams: readonly [TeamDocument, TeamDocument]
  readonly reward: RewardDocument
  readonly createdBy: string
  readonly createdAt: Date
  readonly version: Int32 | number
  readonly battle?: BattleDocument | null
  readonly events?: readonly BattleEventDocument[]
  readonly handledCommands?: readonly HandledCommandDocument[]
  /**
   * HU-21 (migracion 009): resultado unico de una sala FINISHED. JSON puro con
   * la forma exacta del contrato §5. Aditivo y opcional: un documento anterior a
   * HU-21 no lo tiene y se restaura como `null` (y su estado nunca es FINISHED).
   */
  readonly result?: Readonly<Record<string, unknown>> | null
}

const toInt = (value: Int32 | number, field: string, roomId: string): number => {
  const raw = typeof value === 'number' ? value : value.valueOf()

  if (!Number.isInteger(raw) || raw < 0) {
    throw new BattleRoomMappingError(
      `El campo "${field}" de la sala "${roomId}" no es un entero no negativo: ${String(raw)}.`,
    )
  }

  return raw
}

const toTeamSnapshot = (team: TeamDocument, roomId: string): TeamSnapshot => ({
  label: team.label,
  capacity: toInt(team.capacity, `teams.capacity (${team.label})`, roomId),
  participants: team.participants.map((participant) => ({
    kind: participant.kind,
    playerId: participant.playerId,
    heroId: participant.heroId,
    heroLoadoutVersion: participant.heroLoadoutVersion ?? null,
    displayName: participant.displayName ?? null,
    joinedAt: participant.joinedAt,
  })),
})

export const toSnapshot = (document: BattleRoomDocument): BattleRoomSnapshot => {
  if (!(document.createdAt instanceof Date) || Number.isNaN(document.createdAt.getTime())) {
    throw new BattleRoomMappingError(
      `La fecha de creacion de la sala "${document._id}" no es valida.`,
    )
  }

  return {
    id: document._id,
    mode: document.mode as BattleRoomSnapshot['mode'],
    status: document.status as BattleRoomSnapshot['status'],
    teams: [
      toTeamSnapshot(document.teams[0], document._id),
      toTeamSnapshot(document.teams[1], document._id),
    ],
    reward: { amount: document.reward.amount },
    createdBy: document.createdBy,
    createdAt: document.createdAt,
    version: toInt(document.version, 'version', document._id),
    battle: toBattleSnapshot(document),
    events: (document.events ?? []).map((event) => toEvent(event, document._id)),
    handledCommands: (document.handledCommands ?? []).map((handled): HandledCommand => ({
      commandId: handled.commandId,
      seq: toInt(handled.seq, 'handledCommands.seq', document._id),
    })),
    result:
      document.result === undefined || document.result === null
        ? null
        : parseBattleResult(document.result),
  }
}

const toBattleSnapshot = (document: BattleRoomDocument): BattleStateSnapshot | null =>
  document.battle === undefined || document.battle === null
    ? null
    : {
        startedAt: document.battle.startedAt,
        // Aditivo (HU-21): ausente en una batalla anterior, y entonces su turno
        // empezo con la batalla (contrato §12), sin reescribir el documento.
        turnStartedAt: document.battle.turnStartedAt ?? document.battle.startedAt,
        turnOrder: document.battle.turnOrder.map((entry) => ({ ...entry })),
        turnsCompleted: toInt(
          document.battle.turnsCompleted,
          'battle.turnsCompleted',
          document._id,
        ),
        combatants: document.battle.combatants ?? null,
      }

const toEvent = (event: BattleEventDocument, roomId: string): BattleEvent => ({
  seq: toInt(event.seq, 'events.seq', roomId),
  type: event.type as BattleEvent['type'],
  occurredAt: event.occurredAt,
  payload: event.payload as unknown as BattleEvent['payload'],
})

const toTeamDocument = (team: TeamSnapshot): TeamDocument => ({
  label: team.label,
  capacity: new Int32(team.capacity),
  participants: team.participants.map((participant) => ({
    kind: participant.kind,
    playerId: participant.playerId ?? null,
    heroId: participant.heroId ?? null,
    heroLoadoutVersion: participant.heroLoadoutVersion ?? null,
    displayName: participant.displayName ?? null,
    joinedAt: participant.joinedAt ?? new Date(0),
  })),
})

export const toDocument = (snapshot: BattleRoomSnapshot): BattleRoomDocument => ({
  _id: snapshot.id,
  mode: snapshot.mode,
  status: snapshot.status,
  teams: [toTeamDocument(snapshot.teams[0]), toTeamDocument(snapshot.teams[1])],
  reward: { amount: snapshot.reward.amount },
  createdBy: snapshot.createdBy,
  createdAt: snapshot.createdAt,
  version: new Int32(snapshot.version),
  battle:
    snapshot.battle === null
      ? null
      : {
          startedAt: snapshot.battle.startedAt,
          turnStartedAt: snapshot.battle.turnStartedAt ?? snapshot.battle.startedAt,
          turnOrder: snapshot.battle.turnOrder.map((entry) => ({ ...entry })),
          turnsCompleted: snapshot.battle.turnsCompleted,
          // Solo se escribe cuando existe: una batalla anterior a HU-18 no se rellena.
          ...(snapshot.battle.combatants === undefined || snapshot.battle.combatants === null
            ? {}
            : { combatants: snapshot.battle.combatants }),
        },
  events: snapshot.events.map((event): BattleEventDocument => ({
    seq: event.seq,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload as unknown as Readonly<Record<string, unknown>>,
  })),
  handledCommands: snapshot.handledCommands.map((handled) => ({ ...handled })),
  // JSON puro, igual que el `payload` de un evento: el documento guarda la
  // forma validada por `parseBattleResult`, no el objeto tipado del dominio.
  result: snapshot.result as unknown as Readonly<Record<string, unknown>> | null,
})
