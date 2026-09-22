import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryRealtimeTicketStore } from '../../src/adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../src/application/errors/ApplicationError'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { RealtimeTicketCodecPort } from '../../src/application/ports/RealtimeTicketPort'
import { CompleteBattleTurn } from '../../src/application/use-cases/CompleteBattleTurn'
import { GetBattleRoom } from '../../src/application/use-cases/GetBattleRoom'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
  TICKET_TTL_SECONDS,
} from '../../src/application/use-cases/RealtimeTickets'
import { ResumeBattle } from '../../src/application/use-cases/ResumeBattle'
import { NotYourTurnError, BattleNotInProgressError } from '../../src/domain/errors/BattleErrors'
import {
  NOW,
  ROOM_ID,
  clock,
  inBattleRoom,
  loggingRepository,
  preparingRoom,
  recordingPublisher,
} from '../fixtures/battle'

const activeOf = async (repo: BattleRoomRepositoryPort): Promise<string> =>
  (await repo.findById(ROOM_ID))?.battle?.currentEntry.playerId ?? ''

describe('CompleteBattleTurn — avance server-side, idempotente y sin saltos (HU-17)', () => {
  it('avanza al siguiente, persiste y publica turnAdvanced con seq 2', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const publisher = recordingPublisher()

    await repo.save(inBattleRoom(), 0)
    const useCase = new CompleteBattleTurn(repo, clock, publisher)

    const dto = await useCase.execute({
      roomId: ROOM_ID,
      actorPlayerId: await activeOf(repo),
      commandId: 'c-1',
    })

    expect(dto.battle?.turnsCompleted).toBe(1)
    expect(dto.lastSeq).toBe(2)
    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]?.events.map((e) => `${e.type}#${String(e.seq)}`)).toEqual([
      'turnAdvanced#2',
    ])
  })

  it('persiste ANTES de difundir', async () => {
    const log: string[] = []
    const repo = loggingRepository(new InMemoryBattleRoomRepository(), log)

    await repo.save(inBattleRoom(), 0)
    log.length = 0
    const useCase = new CompleteBattleTurn(repo, clock, recordingPublisher(log))

    await useCase.execute({
      roomId: ROOM_ID,
      actorPlayerId: await activeOf(repo),
      commandId: 'c-1',
    })

    expect(log).toEqual(['save:v2', 'publish:turnAdvanced#2'])
  })

  it('el orden se conserva tras varias rondas: la cola no cambia y el turno vuelve al primero', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await repo.save(inBattleRoom({ teamSizes: [2, 2] }), 0)
    const before = (await repo.findById(ROOM_ID))?.battle?.turnOrder.map((entry) => entry.playerId)
    const useCase = new CompleteBattleTurn(repo, clock, recordingPublisher())
    const actors: string[] = []

    for (let turn = 0; turn < 9; turn += 1) {
      const actor = await activeOf(repo)

      actors.push(actor)
      await useCase.execute({
        roomId: ROOM_ID,
        actorPlayerId: actor,
        commandId: `c-${String(turn)}`,
      })
    }

    const room = await repo.findById(ROOM_ID)

    expect(room?.battle?.turnOrder.map((entry) => entry.playerId)).toEqual(before)
    expect(actors.slice(0, 4)).toEqual(before)
    expect(actors.slice(4, 8)).toEqual(before)
    expect(room?.battle?.round).toBe(3)
    expect(room?.lastSeq).toBe(10)
  })

  it('duplicar el commandId no avanza dos veces, no persiste y no difunde', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const publisher = recordingPublisher()

    await repo.save(inBattleRoom(), 0)
    const useCase = new CompleteBattleTurn(repo, clock, publisher)
    const input = { roomId: ROOM_ID, actorPlayerId: await activeOf(repo), commandId: 'mismo' }

    const first = await useCase.execute(input)
    const repeated = await useCase.execute({ ...input, actorPlayerId: 'cualquiera' })

    expect(repeated).toEqual(first)
    expect(publisher.published).toHaveLength(1)
    expect((await repo.findById(ROOM_ID))?.battle?.turnsCompleted).toBe(1)
  })

  it('quien no es el participante activo no puede cerrar el turno', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const publisher = recordingPublisher()

    await repo.save(inBattleRoom(), 0)
    const active = await activeOf(repo)
    const other = active === 'a1' ? 'b1' : 'a1'

    await expect(
      new CompleteBattleTurn(repo, clock, publisher).execute({
        roomId: ROOM_ID,
        actorPlayerId: other,
        commandId: 'c',
      }),
    ).rejects.toBeInstanceOf(NotYourTurnError)
    expect(publisher.published).toEqual([])
  })

  it('sin batalla en curso, o sala inexistente, falla', async () => {
    const repo = new InMemoryBattleRoomRepository()
    const useCase = new CompleteBattleTurn(repo, clock, recordingPublisher())

    await expect(
      useCase.execute({ roomId: ROOM_ID, actorPlayerId: 'a1', commandId: 'c' }),
    ).rejects.toBeInstanceOf(RoomNotFoundError)

    await repo.save(preparingRoom(), 0)

    await expect(
      useCase.execute({ roomId: ROOM_ID, actorPlayerId: 'a1', commandId: 'c' }),
    ).rejects.toBeInstanceOf(BattleNotInProgressError)
  })

  describe('concurrencia: el turno nunca se incrementa dos veces', () => {
    it('dos cierres concurrentes con DISTINTO commandId del participante activo: solo uno avanza', async () => {
      const inner = new InMemoryBattleRoomRepository()

      await inner.save(inBattleRoom(), 0)
      const active = await activeOf(inner)
      const publisher = recordingPublisher()
      const useCase = new CompleteBattleTurn(inner, clock, publisher)

      const results = await Promise.allSettled([
        useCase.execute({ roomId: ROOM_ID, actorPlayerId: active, commandId: 'c-1' }),
        useCase.execute({ roomId: ROOM_ID, actorPlayerId: active, commandId: 'c-2' }),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: expect.any(NotYourTurnError),
      })
      expect((await inner.findById(ROOM_ID))?.battle?.turnsCompleted).toBe(1)
      expect(publisher.published).toHaveLength(1)
    })

    it('dos cierres concurrentes con el MISMO commandId: uno avanza y el otro recibe el mismo resultado', async () => {
      const inner = new InMemoryBattleRoomRepository()

      await inner.save(inBattleRoom(), 0)
      const active = await activeOf(inner)
      const publisher = recordingPublisher()
      const useCase = new CompleteBattleTurn(inner, clock, publisher)
      const input = { roomId: ROOM_ID, actorPlayerId: active, commandId: 'igual' }

      const [a, b] = await Promise.all([useCase.execute(input), useCase.execute(input)])

      expect(a.battle?.turnsCompleted).toBe(1)
      expect(b.battle?.turnsCompleted).toBe(1)
      expect((await inner.findById(ROOM_ID))?.lastSeq).toBe(2)
      expect(publisher.published).toHaveLength(1)
    })

    it('tras agotar los reintentos por conflicto, propaga RoomConflictError', async () => {
      const inner = new InMemoryBattleRoomRepository()

      await inner.save(inBattleRoom(), 0)
      const active = await activeOf(inner)
      let saves = 0
      const conflicting: BattleRoomRepositoryPort = {
        findById: (id) => inner.findById(id),
        findWaitingForPlayers: () => inner.findWaitingForPlayers(),
        findInBattle: () => inner.findInBattle(),
        findFinishedSince: (since) => inner.findFinishedSince(since),
        save: () => {
          saves += 1

          return Promise.reject(new RoomConflictError(ROOM_ID))
        },
      }

      await expect(
        new CompleteBattleTurn(conflicting, clock, recordingPublisher()).execute({
          roomId: ROOM_ID,
          actorPlayerId: active,
          commandId: 'c',
        }),
      ).rejects.toBeInstanceOf(RoomConflictError)
      expect(saves).toBe(3)
    })
  })

  it('un fallo al difundir no falla el avance (el estado ya esta persistido)', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await repo.save(inBattleRoom(), 0)
    const useCase = new CompleteBattleTurn(repo, clock, {
      publish: () => {
        throw new Error('gateway caido')
      },
    })

    const dto = await useCase.execute({
      roomId: ROOM_ID,
      actorPlayerId: await activeOf(repo),
      commandId: 'c',
    })

    expect(dto.battle?.turnsCompleted).toBe(1)
  })
})

describe('GetBattleRoom y ResumeBattle — solo participantes (HU-17)', () => {
  const battleRepo = async (advance = 0): Promise<InMemoryBattleRoomRepository> => {
    const repo = new InMemoryBattleRoomRepository()

    await repo.save(inBattleRoom(), 0)
    const useCase = new CompleteBattleTurn(repo, clock, recordingPublisher())

    for (let turn = 0; turn < advance; turn += 1) {
      await useCase.execute({
        roomId: ROOM_ID,
        actorPlayerId: await activeOf(repo),
        commandId: `c-${String(turn)}`,
      })
    }

    return repo
  }

  it('GetBattleRoom devuelve la sala con su batalla a un participante', async () => {
    const dto = await new GetBattleRoom(await battleRepo()).execute(ROOM_ID, 'a1')

    expect(dto.status).toBe('IN_BATTLE')
    expect(dto.battle?.turnOrder).toHaveLength(2)
  })

  it('GetBattleRoom rechaza a quien no participa y a una sala inexistente', async () => {
    const useCase = new GetBattleRoom(await battleRepo())

    await expect(useCase.execute(ROOM_ID, 'intruso')).rejects.toBeInstanceOf(
      RoomAccessForbiddenError,
    )
    await expect(
      useCase.execute('00000000-0000-4000-8000-000000000009', 'a1'),
    ).rejects.toBeInstanceOf(RoomNotFoundError)
  })

  it('resume con lastSeq valido: reenvia EN ORDEN los eventos posteriores', async () => {
    const result = await new ResumeBattle(await battleRepo(3)).execute(ROOM_ID, 'a1', 1)

    expect(result.kind).toBe('replay')
    expect(result.seq).toBe(4)
    expect(result.kind === 'replay' && result.events.map((event) => event.seq)).toEqual([2, 3, 4])
  })

  it('resume con lastSeq igual al ultimo: replay vacio (el cliente ya esta al dia)', async () => {
    const result = await new ResumeBattle(await battleRepo(2)).execute(ROOM_ID, 'b1', 3)

    expect(result).toMatchObject({ kind: 'replay', seq: 3, events: [] })
  })

  it.each([undefined, null, 0, -1, 2.5, 99, '3'])(
    'resume con lastSeq %p: instantanea completa',
    async (lastSeq) => {
      const result = await new ResumeBattle(await battleRepo(1)).execute(ROOM_ID, 'a1', lastSeq)

      expect(result.kind).toBe('snapshot')
      expect(result.kind === 'snapshot' && result.snapshot).toMatchObject({
        type: 'snapshot',
        roomId: ROOM_ID,
        seq: 2,
        status: 'IN_BATTLE',
      })
      expect(result.kind === 'snapshot' && result.snapshot.battle?.turnsCompleted).toBe(1)
    },
  )

  it('un no participante NO puede hacer resume de una batalla ajena', async () => {
    await expect(
      new ResumeBattle(await battleRepo()).execute(ROOM_ID, 'intruso', 1),
    ).rejects.toBeInstanceOf(RoomAccessForbiddenError)
  })

  it('el snapshot de una sala sin batalla lleva battle null y seq 0', async () => {
    const repo = new InMemoryBattleRoomRepository()

    await repo.save(preparingRoom(), 0)
    const result = await new ResumeBattle(repo).execute(ROOM_ID, 'a1', undefined)

    expect(result.kind === 'snapshot' && result.snapshot).toMatchObject({
      seq: 0,
      status: 'PREPARING',
      battle: null,
    })
  })
})

describe('Tickets del WebSocket — un solo uso, 30 s, solo hash (ADR-020)', () => {
  const build = (): {
    issue: IssueRealtimeTicket
    consume: ConsumeRealtimeTicket
    store: InMemoryRealtimeTicketStore
    codec: RealtimeTicketCodecPort
    setNow: (date: Date) => void
  } => {
    let now = NOW
    const codec: RealtimeTicketCodecPort = {
      generate: (() => {
        let counter = 0

        return () => `ticket-${String((counter += 1))}`
      })(),
      hash: (ticket) => `hash(${ticket})`,
    }
    const store = new InMemoryRealtimeTicketStore()
    const movable = { now: () => now }

    return {
      issue: new IssueRealtimeTicket(codec, store, movable),
      consume: new ConsumeRealtimeTicket(codec, store, movable),
      store,
      codec,
      setNow: (date) => {
        now = date
      },
    }
  }

  it('emite un ticket con caducidad de 30 s y lo consume una vez devolviendo el sub', () => {
    const { issue, consume } = build()
    const issued = issue.execute('sub-1')

    expect(issued.expiresInSeconds).toBe(TICKET_TTL_SECONDS)
    expect(TICKET_TTL_SECONDS).toBe(30)
    expect(consume.execute(issued.ticket)).toBe('sub-1')
  })

  it('un ticket usado NO se puede volver a usar', () => {
    const { issue, consume } = build()
    const { ticket } = issue.execute('sub-1')

    expect(consume.execute(ticket)).toBe('sub-1')
    expect(consume.execute(ticket)).toBeNull()
  })

  it('un ticket caducado (mas de 30 s) se rechaza, y se consume igualmente', () => {
    const { issue, consume, setNow } = build()
    const { ticket } = issue.execute('sub-1')

    setNow(new Date(NOW.getTime() + 30_001))

    expect(consume.execute(ticket)).toBeNull()

    setNow(NOW)

    expect(consume.execute(ticket)).toBeNull()
  })

  it('un ticket en el ultimo instante valido todavia funciona', () => {
    const { issue, consume, setNow } = build()
    const { ticket } = issue.execute('sub-1')

    setNow(new Date(NOW.getTime() + 29_999))

    expect(consume.execute(ticket)).toBe('sub-1')
  })

  it.each([undefined, null, 42, '', 'no-emitido', 'x'.repeat(257), {}])(
    'un ticket incorrecto (%p) se rechaza',
    (ticket) => {
      expect(build().consume.execute(ticket)).toBeNull()
    },
  )

  it('cada ticket queda ligado a SU sub: dos jugadores, dos tickets distintos', () => {
    const { issue, consume } = build()
    const a = issue.execute('sub-a')
    const b = issue.execute('sub-b')

    expect(a.ticket).not.toBe(b.ticket)
    expect(consume.execute(b.ticket)).toBe('sub-b')
    expect(consume.execute(a.ticket)).toBe('sub-a')
  })

  it('solo se guarda el HASH: el ticket en claro no aparece en el almacen', () => {
    const { issue, store } = build()
    const { ticket } = issue.execute('sub-1')
    const serialized = JSON.stringify([
      ...(store as unknown as { tickets: Map<string, unknown> }).tickets,
    ])

    expect(serialized).not.toContain(ticket + '"')
    expect(serialized).toContain('hash(ticket-1)')
  })

  it('el almacen purga los tickets caducados al emitir uno nuevo (no crece sin limite)', () => {
    const store = new InMemoryRealtimeTicketStore()

    // Reloj FIJO e inyectado: la prueba no depende de la fecha real (antes, emitir purgaba
    // con `Date.now()` y una fecha fija de prueba en el pasado rompia el orden de las purgas).
    const now = new Date('2030-01-01T00:00:00.000Z')

    store.issue('h1', 's', new Date(now.getTime() - 1000), now)
    store.issue('h2', 's', new Date(now.getTime() + 60_000), now)

    expect((store as unknown as { tickets: Map<string, unknown> }).tickets.has('h1')).toBe(false)
    expect((store as unknown as { tickets: Map<string, unknown> }).tickets.has('h2')).toBe(true)
  })
})
