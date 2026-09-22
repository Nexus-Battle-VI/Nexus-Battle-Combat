import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import type { BattleDeadlineBookPort } from '../../src/application/ports/BattleDeadlineBookPort'
import type { BattlePresencePort } from '../../src/application/ports/BattlePresencePort'
import type {
  BattleFinishedNotification,
  BattleResultPublisherPort,
} from '../../src/application/ports/BattleResultPublisherPort'
import type { BattleRoomReleasePort } from '../../src/application/ports/BattleRoomReleasePort'
import type { RealtimeNotifierPort } from '../../src/application/ports/RealtimeNotifierPort'
import type { BattleEventPublisherPort } from '../../src/application/ports/BattleEventPublisherPort'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import { BattleFinalizer } from '../../src/application/services/BattleFinalizer'
import { BattleDeadlineSettler } from '../../src/application/services/BattleDeadlineSettler'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'

/**
 * Fixture de la finalizacion (HU-21): dobles en memoria de los puertos, un
 * publicador y un liberador que registran su orden de llamada, y el cableado
 * `Settler` + `Finalizer` listo para las pruebas de servicios y casos de uso.
 */

/** Presencia en memoria con las semanticas del contrato §4.2. */
export const memoryPresence = (): BattlePresencePort & {
  readonly all: Map<string, Date>
} => {
  const byRoom = new Map<string, Map<string, Date>>()
  const absent = (roomId: string): Map<string, Date> => {
    const existing = byRoom.get(roomId)

    if (existing !== undefined) {
      return existing
    }

    const created = new Map<string, Date>()
    byRoom.set(roomId, created)

    return created
  }

  return {
    all: new Map(),
    markAbsent: (roomId, playerId, since) => {
      const room = absent(roomId)
      const current = room.get(playerId)

      if (current === undefined || since.getTime() < current.getTime()) {
        room.set(playerId, since)
      }
    },
    markPresent: (roomId, playerId) => {
      absent(roomId).delete(playerId)
    },
    absences: (roomId) => new Map(absent(roomId)),
    clear: (roomId) => {
      byRoom.delete(roomId)
    },
  }
}

/** Libro de vencimientos en memoria con las semanticas del puerto. */
export const memoryBook = (): BattleDeadlineBookPort & {
  readonly due: Map<string, Date>
} => {
  const due = new Map<string, Date>()

  return {
    due,
    ensureDueBy: (roomId, dueAt) => {
      const current = due.get(roomId)

      if (current === undefined || dueAt.getTime() < current.getTime()) {
        due.set(roomId, dueAt)
      }
    },
    setDue: (roomId, dueAt) => {
      due.set(roomId, dueAt)
    },
    cancel: (roomId) => {
      due.delete(roomId)
    },
    dueRooms: (now) =>
      [...due.entries()]
        .filter(([, dueAt]) => dueAt.getTime() <= now.getTime())
        .map(([roomId]) => roomId),
  }
}

export interface FinalizationHarness {
  readonly rooms: BattleRoomRepositoryPort
  readonly presence: ReturnType<typeof memoryPresence>
  readonly book: ReturnType<typeof memoryBook>
  readonly notifier: RealtimeNotifierPort
  readonly release: BattleRoomReleasePort
  readonly results: BattleResultPublisherPort
  readonly order: string[]
  readonly notifications: BattleFinishedNotification[]
  readonly published: { roomId: string; events: readonly BattleEvent[] }[]
  readonly finalizer: BattleFinalizer
  readonly settler: BattleDeadlineSettler
}

/** Reloj mutable de pruebas: `advance` mueve el instante sin temporizadores reales. */
export const mutableClock = (
  initial: Date,
): { now: () => Date; set: (instant: Date) => void; advance: (ms: number) => void } => {
  let current = initial

  return {
    now: () => new Date(current.getTime()),
    set: (instant) => {
      current = instant
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

export const finalizationHarness = (
  order: string[] = [],
  clock: { now: () => Date } = { now: () => new Date('2026-09-21T10:30:00.000Z') },
): FinalizationHarness & { readonly rooms: InMemoryBattleRoomRepository } => {
  const rooms = new InMemoryBattleRoomRepository()
  const presence = memoryPresence()
  const book = memoryBook()
  const notifications: BattleFinishedNotification[] = []
  const published: { roomId: string; events: readonly BattleEvent[] }[] = []

  const notifier: RealtimeNotifierPort = {
    notifyRoomUpdated: (event) => {
      order.push(`notify:${event.status}`)
    },
  }
  const release: BattleRoomReleasePort = {
    release: (roomId) => {
      order.push(`release:${roomId}`)
    },
  }
  const results: BattleResultPublisherPort = {
    publish: (notification) => {
      order.push('publish:result')
      notifications.push(notification)
    },
  }
  const events: BattleEventPublisherPort = {
    publish: (roomId, fresh) => {
      order.push(`publish:${fresh.map((event) => event.type).join(',')}`)
      published.push({ roomId, events: fresh })
    },
  }

  const finalizer = new BattleFinalizer(book, presence, notifier, release, results, {
    error: () => {
      order.push('log:error')
    },
  })

  const settler = new BattleDeadlineSettler(rooms, presence, book, clock, events, finalizer)

  return {
    rooms,
    presence,
    book,
    notifier,
    release,
    results,
    order,
    notifications,
    published,
    finalizer,
    settler,
  }
}
