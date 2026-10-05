import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryCombatDecisionTelemetryRepository } from '../../src/adapters/outbound/persistence/InMemoryCombatDecisionTelemetryRepository'
import { Sha256CommandIdFingerprint } from '../../src/adapters/outbound/system/Sha256CommandIdFingerprint'
import type { BattleEventPublisherPort } from '../../src/application/ports/BattleEventPublisherPort'
import type { AiDecisionPort } from '../../src/application/ports/AiDecisionPort'
import { createBoundedRandom } from '../../src/application/services/BoundedRandom'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import { DecisionPolicySelector } from '../../src/application/services/DecisionPolicySelector'
import { RandomPolicy } from '../../src/application/policies/RandomPolicy'
import { RuleBasedPolicy } from '../../src/application/policies/RuleBasedPolicy'
import { CompleteBattleTurn } from '../../src/application/use-cases/CompleteBattleTurn'
import { ExecuteBasicAttack } from '../../src/application/use-cases/ExecuteBasicAttack'
import { UseSkill } from '../../src/application/use-cases/UseSkill'
import { UseEpic } from '../../src/application/use-cases/UseEpic'
import { AiTurnTrigger, ExecuteAiTurn } from '../../src/application/use-cases/ExecuteAiTurn'
import { NoLegalDecisionActionsError } from '../../src/domain/errors/DecisionContractErrors'
import { Combatant } from '../../src/domain/entities/Combatant'
import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import type { TurnOrderEntry } from '../../src/domain/entities/TurnOrder'
import type { CombatProfile } from '../../src/domain/entities/CombatProfile'
import type { BattleFinalizer } from '../../src/application/services/BattleFinalizer'
import {
  NOW,
  ROOM_ID,
  clock,
  preparingRoom,
  scriptedSequence,
  silentLogger,
} from '../fixtures/battle'
import { combatProfileFixture } from '../fixtures/basic-attack'
import { FOREST_SONG_FIXED, REANIMATE, skillProfile } from '../fixtures/skills'
import { EPICA_DANO, epicProfile } from '../fixtures/epic'

/**
 * HU-93.2 (EN-035.2/.3/.4): turno automatico de IA en JcE 1v1 Humano vs IA.
 *
 * El equipo B (AI) abre la cola (`aiFirst`), asi que `currentEntry` es SIEMPRE
 * la IA en los escenarios "positivos" de este archivo, sin depender de
 * `BotParticipantFactory` (eso es HU-93.1, ya cubierto en otro archivo):
 * aqui se construye el agregado con las piezas publicas del dominio, igual
 * que `battleWithCombat`, pero con un perfil REAL para el participante AI
 * (esa fixture siempre lo deja en `null`).
 */
const aiVsHumanRoom = (options: {
  readonly aiProfile: CombatProfile
  readonly aiHeroSubtype?: string | null
  readonly aiHealth?: number
  readonly humanProfile?: CombatProfile
  readonly aiFirst?: boolean
}): BattleRoom => {
  const room = preparingRoom({ aiInTeamB: 1 })
  const roster = room.roster()
  const teams = options.aiFirst === false ? [roster[0], roster[1]] : [roster[1], roster[0]]
  const order: TurnOrderEntry[] = teams.flatMap((team) =>
    team.members.map((member) => ({
      ...member,
      heroSubtype: member.playerId === null ? (options.aiHeroSubtype ?? null) : 'GUERRERO_ARMAS',
    })),
  )
  const combatants = order.map((entry) => {
    if (entry.playerId !== null) {
      return Combatant.start(entry, options.humanProfile ?? combatProfileFixture())
    }

    const started = Combatant.start(entry, options.aiProfile)

    return options.aiHealth === undefined ? started : started.withHealth(options.aiHealth)
  })

  return room.startBattle(order, NOW, combatants)
}

const fakeFinalizer = (): { calls: BattleRoom[]; finalizer: BattleFinalizer } => {
  const calls: BattleRoom[] = []

  return {
    calls,
    finalizer: {
      afterFinished: (room: BattleRoom) => calls.push(room),
    } as unknown as BattleFinalizer,
  }
}

const fakePublisher = (): { calls: unknown[]; publisher: BattleEventPublisherPort } => {
  const calls: unknown[] = []

  return { calls, publisher: { publish: (roomId, events) => calls.push({ roomId, events }) } }
}

const setup = (room: BattleRoom, overrides: { readonly primary?: AiDecisionPort } = {}) => {
  const rooms = new InMemoryBattleRoomRepository()
  void rooms.save(room, 0)

  const lock = new ChannelLock()
  const sequence = scriptedSequence(
    Array.from({ length: 200 }, (_value, index) => (index % 8000) + 1),
  )
  const fallbackSequence = scriptedSequence(
    Array.from({ length: 200 }, (_value, index) => (index % 8000) + 1),
  )
  const fallbackRandom = createBoundedRandom(fallbackSequence)

  const attack = new ExecuteBasicAttack(rooms, clock, sequence, lock)
  const skill = new UseSkill(rooms, clock, sequence, lock, attack)
  const epic = new UseEpic(rooms, clock, sequence, lock)
  const completeTurn = new CompleteBattleTurn(rooms, clock, { publish: () => undefined })
  const telemetry = new InMemoryCombatDecisionTelemetryRepository()
  const decisions = new CombatDecisionRecorder(
    telemetry,
    clock,
    silentLogger,
    new Sha256CommandIdFingerprint(),
  )
  const policies = new DecisionPolicySelector(
    overrides.primary === undefined
      ? { policy: new RuleBasedPolicy(), source: 'RULE_BASED' }
      : { policy: overrides.primary, source: 'RULE_BASED' },
    { policy: new RandomPolicy(fallbackRandom), source: 'RANDOM' },
  )
  const { calls: publishCalls, publisher } = fakePublisher()
  const { calls: finishedRooms, finalizer } = fakeFinalizer()

  const aiTurn = new ExecuteAiTurn(
    rooms,
    lock,
    policies,
    attack,
    skill,
    epic,
    completeTurn,
    decisions,
    publisher,
    finalizer,
    new Sha256CommandIdFingerprint(),
  )
  const trigger = new AiTurnTrigger(aiTurn, silentLogger)

  const currentRoom = async (): Promise<BattleRoom> => {
    const found = await rooms.findById(ROOM_ID)

    if (found === null) throw new Error('la sala desaparecio')

    return found
  }

  return { rooms, aiTurn, trigger, telemetry, sequence, publishCalls, finishedRooms, currentRoom }
}

describe('ExecuteAiTurn — turno automatico de IA en JcE 1v1 (HU-93.2)', () => {
  it('ataque basico: la IA ataca, el turno avanza y queda telemetria RULE_BASED', async () => {
    const room = aiVsHumanRoom({ aiProfile: combatProfileFixture({ attack: 12, defense: 0 }) })
    const { aiTurn, telemetry, currentRoom } = setup(room)

    const executed = await aiTurn.execute(ROOM_ID)

    expect(executed).toBe(true)
    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(1)
    expect(after.battle?.currentEntry.kind).not.toBe('AI')

    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.decisionSource).toBe('RULE_BASED')
    expect(decisions[0]?.selectedAction).toMatchObject({ kind: 'BASIC_ATTACK' })
  })

  it('habilidad: con Ataque nulo, la IA usa su unica habilidad legal (curacion de grupo)', async () => {
    // Una habilidad OFENSIVA (DAMAGE) exige Ataque numerico en el perfil (regla de dominio),
    // asi que la unica habilidad legal para un soporte puro es de curacion.
    const room = aiVsHumanRoom({
      aiProfile: skillProfile({ attack: null, damage: null, abilities: [FOREST_SONG_FIXED] }),
      aiHeroSubtype: 'CHAMAN',
      aiHealth: 1,
    })
    const { aiTurn, telemetry, currentRoom } = setup(room)

    await aiTurn.execute(ROOM_ID)

    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(1)

    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(decisions[0]?.selectedAction).toMatchObject({
      kind: 'ABILITY',
      abilityId: FOREST_SONG_FIXED.abilityId,
    })
  })

  it('epica: con Ataque nulo y sin habilidades, la IA usa la epica equipada', async () => {
    const room = aiVsHumanRoom({
      aiProfile: epicProfile(EPICA_DANO, { attack: null, damage: null }),
      aiHeroSubtype: 'GUERRERO_TANQUE',
    })
    const { aiTurn, telemetry, currentRoom } = setup(room)

    await aiTurn.execute(ROOM_ID)

    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(1)

    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(decisions[0]?.selectedAction).toMatchObject({
      kind: 'EPIC',
      epicId: EPICA_DANO.epicProductId,
    })
  })

  it('soporte sin acciones (Medico): cero candidatas -> END_TURN, sin RNG y sin curar/atacar', async () => {
    const room = aiVsHumanRoom({
      aiProfile: skillProfile({ attack: null, damage: null, abilities: [REANIMATE] }),
      aiHeroSubtype: 'MEDICO',
    })
    const { aiTurn, telemetry, sequence, currentRoom } = setup(room)
    const before = await currentRoom()
    const humanHealthBefore = before.battleView()?.combatants.find((c) => c.teamLabel === 'A')
      ?.health?.current

    await aiTurn.execute(ROOM_ID)

    expect(sequence.consumed()).toBe(0)

    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(1)
    const humanHealthAfter = after.battleView()?.combatants.find((c) => c.teamLabel === 'A')
      ?.health?.current
    expect(humanHealthAfter).toBe(humanHealthBefore)

    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.schemaVersion).toBe(2)
    expect(decisions[0]?.decisionSource).toBe('SYSTEM')
    expect(decisions[0]?.legalActions).toHaveLength(0)
    expect(decisions[0]?.selectedAction).toEqual({ kind: 'END_TURN' })
  })

  it('politica principal invalida: usa el fallback (RandomPolicy) y lo registra como tal', async () => {
    const room = aiVsHumanRoom({ aiProfile: combatProfileFixture({ attack: 12, defense: 0 }) })
    const failingPolicy: AiDecisionPort = {
      decide: () => Promise.reject(new NoLegalDecisionActionsError()),
    }
    const { aiTurn, telemetry, currentRoom } = setup(room, { primary: failingPolicy })

    await aiTurn.execute(ROOM_ID)

    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(1)

    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(decisions[0]?.decisionSource).toBe('RANDOM')
  })

  it('PVP: no automatiza nada aunque el actor actual sea AI por construccion directa', async () => {
    const room = aiVsHumanRoom({ aiProfile: combatProfileFixture({ attack: 12, defense: 0 }) })
    // Fuerza PVP manipulando solo lo observable por `ExecuteAiTurn` (el modo),
    // sin pasar por `preparingRoom` (que exige participantes AI para PVE).
    const pvpRoom = Object.create(room, { mode: { value: 'PVP', enumerable: true } }) as BattleRoom
    const { aiTurn, currentRoom } = setup(pvpRoom)

    const executed = await aiTurn.execute(ROOM_ID)

    expect(executed).toBe(false)
    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(0)
  })

  it('turno humano: no hace nada', async () => {
    const room = aiVsHumanRoom({
      aiProfile: combatProfileFixture({ attack: 12, defense: 0 }),
      aiFirst: false,
    })
    const { aiTurn, currentRoom } = setup(room)

    const executed = await aiTurn.execute(ROOM_ID)

    expect(executed).toBe(false)
    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(0)
  })

  it('dos disparos concurrentes: solo se ejecuta un turno (el bloqueo serializa)', async () => {
    const room = aiVsHumanRoom({ aiProfile: combatProfileFixture({ attack: 12, defense: 0 }) })
    const { aiTurn, telemetry, currentRoom } = setup(room)

    const [first, second] = await Promise.all([aiTurn.execute(ROOM_ID), aiTurn.execute(ROOM_ID)])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    const after = await currentRoom()
    expect(after.battle?.turnsCompleted).toBe(1)

    const decisions = await telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)
    expect(decisions).toHaveLength(1)
  })

  it('accion terminal: publica, llama al finalizador UNA vez y no encadena otro turno', async () => {
    const room = aiVsHumanRoom({
      aiProfile: combatProfileFixture({ attack: 12, defense: 0 }),
      humanProfile: combatProfileFixture({ maxHealth: 1, defense: 0 }),
    })
    const { aiTurn, publishCalls, finishedRooms } = setup(room)

    const executed = await aiTurn.execute(ROOM_ID)

    expect(executed).toBe(true)
    expect(publishCalls).toHaveLength(1)
    expect(finishedRooms).toHaveLength(1)
    expect(finishedRooms[0]?.status).toBe('FINISHED')
  })
})
