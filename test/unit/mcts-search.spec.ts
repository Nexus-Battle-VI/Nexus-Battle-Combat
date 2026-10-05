import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { legalActionIdentity } from '../../src/domain/decision/ActionIdentity'
import type { MctsTeacherConfig } from '../../src/domain/decision/MctsTeacherResult'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import {
  DecisionStateUnavailableError,
  NoLegalDecisionActionsError,
} from '../../src/domain/errors/DecisionContractErrors'
import { InvalidMctsConfigError } from '../../src/domain/errors/MctsErrors'
import { InMemoryMctsSimulationAdapter } from '../../src/adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { MctsSearch, extractUtilityVitals } from '../../src/application/services/MctsSearch'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import { battleWithSkills } from '../fixtures/skills'
import { clock, preparingRoom } from '../fixtures/battle'

const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
const simulation = new InMemoryMctsSimulationAdapter(clock)

const search = (): MctsSearch => new MctsSearch(simulation, factory)

const SEED = 3_000_000

describe('MctsSearch (teacher MCTS, EN-036.1)', () => {
  it('M-01: las probabilidades de los candidatos suman 1 y los visits suman rollouts', async () => {
    const room = battleWithCombat()
    const config: MctsTeacherConfig = { ...MCTS_TEACHER_V1_CONFIG, rollouts: 32 }

    const result = await search().search(room, config, SEED)

    const totalVisits = result.candidates.reduce((sum, c) => sum + c.visits, 0)
    const totalProbability = result.candidates.reduce((sum, c) => sum + c.probability, 0)

    expect(totalVisits).toBe(config.rollouts)
    expect(totalProbability).toBeCloseTo(1, 10)
  })

  it('M-02: nunca muta la sala de entrada', async () => {
    const room = battleWithCombat()
    const before = room.toSnapshot()

    await search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 16 }, SEED)

    expect(room.toSnapshot()).toEqual(before)
  })

  it('M-03: reproducible -- misma sala + misma semilla + misma config = mismo resultado', async () => {
    const room = battleWithCombat()
    const config: MctsTeacherConfig = { ...MCTS_TEACHER_V1_CONFIG, rollouts: 24 }

    const first = await search().search(room, config, SEED)
    const second = await search().search(room, config, SEED)

    expect(second).toEqual(first)
  })

  it('M-04: semillas distintas se registran tal cual en el resultado', async () => {
    const room = battleWithCombat()
    const config: MctsTeacherConfig = { ...MCTS_TEACHER_V1_CONFIG, rollouts: 8 }

    const withSeedA = await search().search(room, config, 111)
    const withSeedB = await search().search(room, config, 222)

    expect(withSeedA.simulationSeed).toBe(111)
    expect(withSeedB.simulationSeed).toBe(222)
  })

  it('M-05: sin acciones legales en la raiz, rechaza con NoLegalDecisionActionsError', async () => {
    const room = battleWithCombat()
    const noActions = { generateAvailable: () => [] } as unknown as LegalActionGenerator
    const engine = new MctsSearch(simulation, factory, undefined, noActions)

    await expect(
      engine.search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 4 }, SEED),
    ).rejects.toThrow(NoLegalDecisionActionsError)
  })

  it('M-06: una sala que no esta IN_BATTLE rechaza con DecisionStateUnavailableError', async () => {
    const room = preparingRoom()

    await expect(
      search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 4 }, SEED),
    ).rejects.toThrow(DecisionStateUnavailableError)
  })

  it.each([
    ['rollouts', { ...MCTS_TEACHER_V1_CONFIG, rollouts: 0 }],
    ['maxDepthPlies', { ...MCTS_TEACHER_V1_CONFIG, maxDepthPlies: 0 }],
    ['explorationConstant', { ...MCTS_TEACHER_V1_CONFIG, explorationConstant: -1 }],
  ])('M-07: config invalida (%s) rechaza con InvalidMctsConfigError', async (_label, config) => {
    const room = battleWithCombat()

    await expect(engineSearch(room, config)).rejects.toThrow(InvalidMctsConfigError)
  })

  const engineSearch = (room: BattleRoom, config: MctsTeacherConfig) =>
    search().search(room, config, SEED)

  it('M-08: cada candidato es una accion legal real del estado raiz', async () => {
    const room = battleWithSkills()
    const legalActionGenerator = new LegalActionGenerator()
    const legalActions = legalActionGenerator.generateAvailable(room)
    const legalIdentities = new Set(legalActions.map((action) => legalActionIdentity(action)))

    const result = await search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 48 }, SEED)

    expect(result.candidates.length).toBe(legalActions.length)
    for (const candidate of result.candidates) {
      expect(legalIdentities.has(candidate.actionIdentity)).toBe(true)
      expect(candidate.meanUtility).toBeGreaterThanOrEqual(0)
      expect(candidate.meanUtility).toBeLessThanOrEqual(1)
    }
    expect(legalIdentities.has(legalActionIdentity(result.selectedAction))).toBe(true)
  })

  it('M-09: respeta maxDepthPlies = 1 sin fallar (hoja truncada en la primera jugada)', async () => {
    const room = battleWithCombat()

    const result = await search().search(
      room,
      { ...MCTS_TEACHER_V1_CONFIG, rollouts: 16, maxDepthPlies: 1 },
      SEED,
    )

    expect(result.candidates.reduce((sum, c) => sum + c.visits, 0)).toBe(16)
  })

  it('M-10: perfil con habilidad que consume Poder/recarga llega hasta el final sin error (paridad con el motor real)', async () => {
    const room = battleWithSkills()

    const result = await search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 32 }, SEED)

    const hasAbilityCandidate = result.candidates.some((c) => c.action.kind === 'ABILITY')
    expect(hasAbilityCandidate).toBe(true)
  })

  it('M-11: extrae vitales de un sanador sin Ataque/Dano numerico (perfil tipo Chaman/Medico) sin romper', () => {
    // Un sanador real (Vida/Poder si, Ataque/Dano no) no es un ESTADO PROHIBIDO
    // para la evaluacion de utilidad: solo lo es un `maxHealth`/`maxPower`
    // invalido. `extractUtilityVitals` es lo que `MctsSearch` llama en cada
    // hoja para construir la entrada de `BattleUtilityEvaluator`.
    const healerProfile = combatProfileFixture({ attack: null, damage: null, maxPower: 10 })
    const room = battleWithCombat({ profiles: { a1: healerProfile } })
    const rootActor = {
      teamLabel: room.battle!.currentEntry.teamLabel,
      seat: room.battle!.currentEntry.seat,
    }

    const { actor, enemies } = extractUtilityVitals(room, rootActor)

    expect(actor).toEqual({ currentHealth: 44, maxHealth: 44, power: { current: 10, max: 10 } })
    expect(enemies).toEqual([{ currentHealth: 44, maxHealth: 44 }])
  })

  it('completa 128 rollouts (configuracion v1 por defecto) en un tiempo razonable', async () => {
    const room = battleWithSkills()
    const start = Date.now()

    await search().search(room, MCTS_TEACHER_V1_CONFIG, SEED)

    expect(Date.now() - start).toBeLessThan(20_000)
  })
})
