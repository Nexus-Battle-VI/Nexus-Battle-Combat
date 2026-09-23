import { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type { BattleEvent } from '../../src/domain/entities/BattleEvent'
import type { TeamRoster, TurnOrderEntry } from '../../src/domain/entities/TurnOrder'
import type { BoundedRandom } from '../../src/domain/policies/TurnOrderPolicy'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import type { BattleEventPublisherPort } from '../../src/application/ports/BattleEventPublisherPort'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  EquippedHero,
  PlayerInventoryEquippedHeroPort,
} from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { equippedHeroFixture } from './equipped-hero'

export const NOW = new Date('2026-09-21T10:00:00.000Z')
export const clock: ClockPort = { now: () => NOW }
export const ROOM_ID = '11111111-1111-4111-8111-111111111111'

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Fuente acotada GUIONIZADA: devuelve los valores dados y registra cada `bound` pedido. */
export const scriptedRandom = (
  values: readonly number[],
): BoundedRandom & { readonly bounds: number[] } => {
  const bounds: number[] = []
  let cursor = 0

  return {
    bounds,
    nextInt: (bound: number): number => {
      const value = values[cursor]

      if (value === undefined) {
        throw new Error('scriptedRandom agotado')
      }

      if (value < 0 || value >= bound) {
        throw new Error(`valor ${String(value)} fuera de [0, ${String(bound)})`)
      }

      bounds.push(bound)
      cursor += 1

      return value
    },
  }
}

/** Secuencia de indices GUIONIZADA (HU-24 port). Lanza si se agota. */
export const scriptedSequence = (
  indices: readonly number[],
): RandomSequencePort & { readonly consumed: () => number } => {
  let cursor = 0

  return {
    consumed: () => cursor,
    nextIndex: () => {
      const value = indices[cursor]

      if (value === undefined) {
        throw new Error('scriptedSequence agotada')
      }

      cursor += 1

      return RandomIndex.create(value)
    },
  }
}

export interface PreparingRoomOptions {
  readonly id?: string
  readonly teamSizes?: readonly [number, number]
  readonly mode?: 'PVP' | 'PVE'
  /** Participantes AI declarados al crear (equipo A, luego B). */
  readonly aiInTeamA?: number
  readonly aiInTeamB?: number
  /** HU-23: monto apostado por jugador (`{ a1: 10 }`); los demas no apuestan. */
  readonly stakes?: Readonly<Record<string, number>>
}

/** Jugadores humanos de una sala: `a1..an` (equipo A) y `b1..bn` (equipo B). */
export const humanIds = (size: readonly [number, number], aiA = 0, aiB = 0): string[] => [
  ...Array.from({ length: size[0] - aiA }, (_, index) => `a${String(index + 1)}`),
  ...Array.from({ length: size[1] - aiB }, (_, index) => `b${String(index + 1)}`),
]

/**
 * Construye una sala en `PREPARING` (cupo completo) usando SOLO el dominio:
 * `create` + `join`. Cada humano queda con `heroId = hero-<id>` y
 * `heroLoadoutVersion = 3`.
 */
export const preparingRoom = (options: PreparingRoomOptions = {}): BattleRoom => {
  const size = options.teamSizes ?? [1, 1]
  const aiA = options.aiInTeamA ?? 0
  const aiB = options.aiInTeamB ?? 0
  const initial = (count: number): { kind: string; heroId: string }[] =>
    Array.from({ length: count }, (_, index) => ({ kind: 'AI', heroId: `ai-${String(index)}` }))

  let room = BattleRoom.create(
    options.id ?? ROOM_ID,
    'a1',
    {
      mode: aiA + aiB > 0 ? 'PVE' : (options.mode ?? 'PVP'),
      teamConfigs: [
        { capacity: size[0], initialParticipants: initial(aiA) },
        { capacity: size[1], initialParticipants: initial(aiB) },
      ],
      reward: { amount: 10 },
    },
    NOW,
  )

  for (const [index, playerId] of humanIds(size, aiA, aiB).entries()) {
    const team = index < size[0] - aiA ? 'A' : 'B'
    const stakeAmount = options.stakes?.[playerId]

    room = room.join(
      playerId,
      team,
      NOW,
      `Nombre ${playerId}`,
      `hero-${playerId}`,
      3,
      stakeAmount === undefined
        ? null
        : {
            amount: stakeAmount,
            holdOperationId: `battle:${room.id}:player:${playerId}:stake:reserve`,
          },
    )
  }

  // HU-23: el fixture no habla con Wallet, asi que la reserva se da por
  // confirmada (en produccion lo hace `StakeReserver` antes de persistir).
  return room.withStakesActivated()
}

/** HU-23: sala ya terminada con ganador explicito (sin pasar por la batalla). */
export const finishedRoom = (
  options: PreparingRoomOptions & { readonly winnerTeamLabel?: string } = {},
): BattleRoom =>
  inBattleRoom(options).finish(
    { reason: 'ELIMINATION', winnerTeamLabel: options.winnerTeamLabel ?? 'A' },
    NOW,
  )

/** HU-23: sala terminada por vencimiento global con vidas iguales -> `NO_WINNER`. */
export const timedOutRoom = (options: PreparingRoomOptions = {}): BattleRoom =>
  inBattleRoom(options).finish({ reason: 'TIME_LIMIT' }, NOW)

/** Sala YA en batalla con la cola generada por el orden de roster (sin sorteo). */
export const inBattleRoom = (options: PreparingRoomOptions = {}): BattleRoom => {
  const room = preparingRoom(options)
  const roster = room.roster()
  const order: TurnOrderEntry[] = []
  const longest = Math.max(roster[0].members.length, roster[1].members.length)

  for (let round = 0; round < longest; round += 1) {
    for (const team of roster) {
      const member = team.members[round]

      if (member !== undefined) {
        order.push({ ...member, heroSubtype: member.playerId === null ? null : 'GUERRERO_ARMAS' })
      }
    }
  }

  return room.startBattle(order, NOW)
}

export const memberOf = (
  teamLabel: string,
  seat: number,
  overrides: Partial<TurnOrderEntry> = {},
): TurnOrderEntry => ({
  teamLabel,
  seat,
  kind: 'HUMAN',
  playerId: `${teamLabel.toLowerCase()}${String(seat + 1)}`,
  displayName: `Nombre ${teamLabel}${String(seat + 1)}`,
  heroId: `hero-${teamLabel.toLowerCase()}${String(seat + 1)}`,
  heroSubtype: 'GUERRERO_ARMAS',
  ...overrides,
})

export const rosterOfSizes = (sizeA: number, sizeB: number): readonly [TeamRoster, TeamRoster] => [
  { label: 'A', members: Array.from({ length: sizeA }, (_, seat) => memberOf('A', seat)) },
  { label: 'B', members: Array.from({ length: sizeB }, (_, seat) => memberOf('B', seat)) },
]

/** `A1`, `B2`... de una cola, para asertar el orden de forma legible. */
export const labels = (order: readonly { teamLabel: string; seat: number }[]): string[] =>
  order.map((entry) => `${entry.teamLabel}${String(entry.seat + 1)}`)

/** Puerto de Player-Inventory con un heroe por jugador (o `null`). */
export const heroesPort = (
  heroes: Readonly<Record<string, EquippedHero | null>> = {},
  fallback: (playerId: string) => EquippedHero | null = (playerId) =>
    equippedHeroFixture({ playerId, heroId: `hero-${playerId}`, loadoutVersion: 3 }),
): PlayerInventoryEquippedHeroPort & { readonly calls: string[] } => {
  const calls: string[] = []

  return {
    calls,
    getEquippedHero: (playerId) => {
      calls.push(playerId)

      return Promise.resolve(playerId in heroes ? (heroes[playerId] ?? null) : fallback(playerId))
    },
  }
}

/** Publicador que registra el orden de las operaciones junto al repositorio. */
export const recordingPublisher = (
  log: string[] = [],
): BattleEventPublisherPort & {
  readonly published: { roomId: string; events: BattleEvent[] }[]
} => {
  const published: { roomId: string; events: BattleEvent[] }[] = []

  return {
    published,
    publish: (roomId, events) => {
      log.push(`publish:${events.map((event) => `${event.type}#${String(event.seq)}`).join(',')}`)
      published.push({ roomId, events: [...events] })
    },
  }
}

/** Repositorio en memoria que registra `save` en el mismo `log` que el publicador. */
export const loggingRepository = (
  inner: BattleRoomRepositoryPort,
  log: string[],
): BattleRoomRepositoryPort => ({
  findById: (id) => inner.findById(id),
  findWaitingForPlayers: () => inner.findWaitingForPlayers(),
  findInBattle: () => inner.findInBattle(),
  findFinishedSince: (since) => inner.findFinishedSince(since),
  findCancelledSince: (since) => inner.findCancelledSince(since),
  findActiveByParticipant: (playerId) => inner.findActiveByParticipant(playerId),
  save: async (room, expectedVersion) => {
    const saved = await inner.save(room, expectedVersion)

    log.push(`save:v${String(saved.version)}`)

    return saved
  },
})
