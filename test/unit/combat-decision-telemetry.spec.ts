import { InMemoryCombatDecisionTelemetryRepository } from '../../src/adapters/outbound/persistence/InMemoryCombatDecisionTelemetryRepository'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { Sha256CommandIdFingerprint } from '../../src/adapters/outbound/system/Sha256CommandIdFingerprint'
import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import type { CombatDecisionTelemetryRepositoryPort } from '../../src/application/ports/CombatDecisionTelemetryRepositoryPort'
import { CombatDecisionTelemetryConflictError } from '../../src/application/ports/CombatDecisionTelemetryRepositoryPort'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import { BattleDecisionStateAssembler } from '../../src/application/services/BattleDecisionStateAssembler'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { battleWithCombat, indexForFace } from '../fixtures/basic-attack'
import { clock, NOW, ROOM_ID, scriptedSequence } from '../fixtures/battle'

const logError = jest.fn()
const silentLogger = { error: logError }
const fixedClock = { now: (): Date => new Date(NOW) }
const commandIds = new Sha256CommandIdFingerprint()
const target = { teamLabel: 'B', seat: 0 } as const

describe('CombatDecisionRecorder e in-memory telemetry', () => {
  beforeEach(() => logError.mockClear())

  it('captures the exact pre-action state and canonical candidates without PII or RNG state', async () => {
    const repository = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const event = recorder.prepareHumanDecision(battleWithCombat(), 'cmd-observe', {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: target },
    })

    await recorder.record(event)

    expect(event).toMatchObject({
      schemaVersion: 1,
      eventType: 'COMBAT_DECISION',
      battleId: ROOM_ID,
      decisionSequence: 0,
      origin: 'ONLINE',
      mode: 'PVP',
      actor: { teamLabel: 'A', seat: 0 },
      decisionSource: 'HUMAN',
      selectedAction: { kind: 'BASIC_ATTACK' },
      occurredAt: NOW,
    })
    expect(event.legalActions).toContainEqual(event.selectedAction)
    expect(JSON.stringify(event)).not.toMatch(
      /playerId|displayName|email|jwt|token|seed|randomCursor|nextRandom/iu,
    )
    await expect(repository.listDecisionsByBattle('ONLINE', ROOM_ID)).resolves.toEqual([event])
  })

  it('hashes arbitrary client command ids before building the persisted event id', () => {
    const repository = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const commandId = 'persona@example.com'
    const event = recorder.prepareHumanDecision(battleWithCombat(), commandId, {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: target },
    })

    expect(event.eventId).toMatch(/^decision:ONLINE:\d+:[^:]+:[a-f0-9]{64}$/u)
    expect(JSON.stringify(event)).not.toContain(commandId)
    expect(
      recorder.prepareHumanDecision(battleWithCombat(), commandId, {
        kind: 'BASIC_ATTACK',
        target: { scope: 'COMBATANT', combatant: target },
      }).eventId,
    ).toBe(event.eventId)
  })

  it('records END_TURN only as a SYSTEM decision with no legal actions', () => {
    const repository = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const room = battleWithCombat()
    const stateBefore = new BattleDecisionStateAssembler().assemble(room)
    const event = recorder.prepareOnline({
      commandId: 'ai-turn:room:0:0',
      battleId: room.id,
      decisionSequence: 0,
      origin: 'ONLINE',
      mode: 'PVE',
      actor: stateBefore.actor.identity,
      decisionSource: 'SYSTEM',
      stateBefore,
      legalActions: [],
      selectedAction: { kind: 'END_TURN' },
    })

    expect(event).toMatchObject({
      schemaVersion: 2,
      decisionSource: 'SYSTEM',
      legalActions: [],
      selectedAction: { kind: 'END_TURN' },
    })
  })

  it('rejects END_TURN when a real action exists or the source is not SYSTEM', () => {
    const repository = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const room = battleWithCombat()
    const stateBefore = new BattleDecisionStateAssembler().assemble(room)
    const legalActions = new LegalActionGenerator().generate(room)
    const base = {
      commandId: 'ai-turn:room:0:0',
      battleId: room.id,
      decisionSequence: 0,
      origin: 'ONLINE' as const,
      mode: 'PVE' as const,
      actor: stateBefore.actor.identity,
      stateBefore,
      selectedAction: { kind: 'END_TURN' as const },
    }

    expect(() =>
      recorder.prepareOnline({
        ...base,
        decisionSource: 'SYSTEM',
        legalActions,
      }),
    ).toThrow()
    expect(() =>
      recorder.prepareOnline({
        ...base,
        decisionSource: 'RULE_BASED',
        legalActions: [],
      }),
    ).toThrow()
  })

  it('treats the same semantic event as a no-op even when retry time differs', async () => {
    const repository = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const event = recorder.prepareHumanDecision(battleWithCombat(), 'cmd-idempotent', {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: target },
    })

    await repository.append(event)
    await repository.append({ ...event, occurredAt: new Date('2030-01-01T00:00:00.000Z') })

    await expect(repository.listDecisionsByBattle('ONLINE', ROOM_ID)).resolves.toHaveLength(1)
  })

  it('rejects a reused event id with divergent semantic content', async () => {
    const repository = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const event = recorder.prepareHumanDecision(battleWithCombat(), 'cmd-conflict', {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: target },
    })

    await repository.append(event)

    await expect(repository.append({ ...event, decisionSource: 'NEURAL' })).rejects.toBeInstanceOf(
      CombatDecisionTelemetryConflictError,
    )
  })

  it('is fail-open and logs only technical identifiers when persistence fails', async () => {
    const repository: CombatDecisionTelemetryRepositoryPort = {
      append: () => Promise.reject(new Error('mongo unavailable')),
      appendMany: () => Promise.reject(new Error('mongo unavailable')),
      listDecisionsByBattle: () => Promise.resolve([]),
      findOutcome: () => Promise.resolve(null),
    }
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const event = recorder.prepareHumanDecision(battleWithCombat(), 'cmd-fail-open', {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: target },
    })

    await expect(recorder.record(event)).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith(
      'combat_decision_telemetry_append_failed',
      expect.objectContaining({
        eventId: event.eventId,
        battleId: ROOM_ID,
        reason: 'Error',
      }),
    )
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/a1|displayName|hero/iu)
  })

  it('attempts and logs every event independently when one batch item fails', async () => {
    const attempted: string[] = []
    const repository: CombatDecisionTelemetryRepositoryPort = {
      append: (event) => {
        attempted.push(event.eventId)

        return event.eventId === 'decision-fails'
          ? Promise.reject(new Error('isolated failure'))
          : Promise.resolve()
      },
      appendMany: () => Promise.reject(new Error('recordMany must persist independently')),
      listDecisionsByBattle: () => Promise.resolve([]),
      findOutcome: () => Promise.resolve(null),
    }
    const recorder = new CombatDecisionRecorder(repository, fixedClock, silentLogger, commandIds)
    const base = recorder.prepareHumanDecision(battleWithCombat(), 'cmd-batch-base', {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: target },
    })
    const events = [
      { ...base, eventId: 'decision-first' },
      { ...base, eventId: 'decision-fails', decisionSequence: 1 },
      { ...base, eventId: 'decision-last', decisionSequence: 2 },
    ]

    await expect(recorder.recordMany(events)).resolves.toBeUndefined()
    expect(attempted).toEqual(['decision-first', 'decision-fails', 'decision-last'])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'combat_decision_telemetry_append_failed',
      expect.objectContaining({ eventId: 'decision-fails', eventCount: 1 }),
    )
  })

  it('appends only after a valid online command is persisted and never duplicates a replay', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(battleWithCombat(), 0)
    const telemetry = new InMemoryCombatDecisionTelemetryRepository()
    const recorder = new CombatDecisionRecorder(telemetry, fixedClock, silentLogger, commandIds)
    const attack = new ExecuteBasicAttack(
      rooms,
      clock,
      scriptedSequence([indexForFace(1, 6)]),
      new ChannelLock(),
      null,
      undefined,
      null,
      recorder,
    )
    const input = {
      roomId: ROOM_ID,
      requesterId: 'a1',
      commandId: 'cmd-persisted-first',
      target,
    }

    const first = await attack.execute(input)
    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    const persistedRoom = await rooms.findById(ROOM_ID)

    expect(first.replayed).toBe(false)
    expect(persistedRoom?.battle?.turnsCompleted).toBe(1)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.stateBefore.context.turnsCompleted).toBe(0)

    await expect(attack.execute(input)).resolves.toMatchObject({ replayed: true })
    await expect(telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)).resolves.toHaveLength(1)

    await expect(
      attack.execute({ ...input, commandId: 'cmd-invalid', target: { teamLabel: 'A', seat: 0 } }),
    ).rejects.toThrow()
    await expect(telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)).resolves.toHaveLength(1)
  })

  it('does not fail or roll back a valid command when the telemetry adapter is unavailable', async () => {
    const rooms = new InMemoryBattleRoomRepository()
    await rooms.save(battleWithCombat(), 0)
    const unavailable: CombatDecisionTelemetryRepositoryPort = {
      append: () => Promise.reject(new Error('telemetry unavailable')),
      appendMany: () => Promise.reject(new Error('telemetry unavailable')),
      listDecisionsByBattle: () => Promise.resolve([]),
      findOutcome: () => Promise.resolve(null),
    }
    const recorder = new CombatDecisionRecorder(unavailable, fixedClock, silentLogger, commandIds)
    const attack = new ExecuteBasicAttack(
      rooms,
      clock,
      scriptedSequence([indexForFace(1, 6)]),
      new ChannelLock(),
      null,
      undefined,
      null,
      recorder,
    )

    await expect(
      attack.execute({
        roomId: ROOM_ID,
        requesterId: 'a1',
        commandId: 'cmd-telemetry-unavailable',
        target,
      }),
    ).resolves.toMatchObject({ replayed: false })
    await expect(rooms.findById(ROOM_ID)).resolves.toMatchObject({
      battle: { turnsCompleted: 1 },
    })
    expect(logError).toHaveBeenCalledWith(
      'combat_decision_telemetry_append_failed',
      expect.any(Object),
    )
  })
})
