import type { BattleRoom } from '../../src/domain/entities/BattleRoom'
import { legalActionIdentity } from '../../src/domain/decision/ActionIdentity'
import type { MctsTeacherConfig } from '../../src/domain/decision/MctsTeacherResult'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import {
  DecisionStateUnavailableError,
  NoLegalDecisionActionsError,
} from '../../src/domain/errors/DecisionContractErrors'
import {
  InvalidMctsConfigError,
  NoStrategicMctsCandidatesError,
} from '../../src/domain/errors/MctsErrors'
import { InMemoryMctsSimulationAdapter } from '../../src/adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { MctsSearch, extractUtilityVitals } from '../../src/application/services/MctsSearch'
import { LegalActionGenerator } from '../../src/application/services/LegalActionGenerator'
import type { MissionRotationInput } from '../../src/application/services/MissionRotationConstraint'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import {
  battleWithSkills,
  AGONY,
  AGONY_ID,
  AGONY_FIXED,
  AGONY_FIXED_ID,
  STORM,
  STORM_ID,
  LIFE_TOUCH,
} from '../fixtures/skills'
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

  it('M-12: cada rollout vuelve a aplicar la accion elegida desde la sala raiz original (no congela un resultado aleatorio, bug #2 de la revision de PR#80)', async () => {
    const room = battleWithCombat() // una sola accion legal (BASIC_ATTACK): todos los rollouts la eligen
    const applyActionSpy = jest.spyOn(simulation, 'applyAction')

    await search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 10 }, SEED)

    // Cada rollout llama a `applyAction` varias veces (la propia + el resto
    // de la trayectoria), pero la PRIMERA llamada de CADA rollout debe partir
    // siempre de la sala raiz original intacta. Si el arbol anterior
    // "congelaba" la primera accion expandida, solo UNA llamada en total
    // habria recibido esa sala raiz; las demas habrian reusado el nodo ya
    // calculado en vez de volver a muestrearlo.
    const callsFromRoot = applyActionSpy.mock.calls.filter((call) => call[0] === room)
    expect(callsFromRoot).toHaveLength(10)

    applyActionSpy.mockRestore()
  })

  it('M-13: el Poder de una hoja terminal refleja lo gastado de verdad, no el Poder restaurado por BattleRoom.finish() (bug #3 de la revision de PR#80)', async () => {
    const lethalProfile = combatProfileFixture({ maxPower: 3, abilities: [AGONY] })
    const room = battleWithCombat({
      profiles: { a1: lethalProfile },
      health: { 'B#0': 1 }, // 2d9 de Agonia (minimo 2) siempre es letal contra 1 de Vida
    })

    const result = await search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 4 }, SEED)

    const agonyCandidate = result.candidates.find(
      (c) => c.action.kind === 'ABILITY' && c.action.abilityId === AGONY_ID,
    )
    expect(agonyCandidate).toBeDefined()

    // W=1 (gana), H=1 (Agonia no inflige dano propio), P=0/3=0 (gasto los 3 de
    // Poder y la sala terminal NO debe leer el Poder restaurado = 1),
    // D=1-0/44=1 (enemigo a 0 de Vida). U = 0.60*1+0.15*1+0.10*0+0.15*1 = 0.90.
    // Si el bug #3 siguiera presente, P se leeria como 1 y U daria 1.00.
    expect(agonyCandidate?.meanUtility).toBeCloseTo(0.9, 10)
  })

  it('M-14: el Poder de una hoja NO terminal incluye la regeneracion de +2 al abrirse el turno propio, no solo el gasto (bug #1 de la segunda revision de PR#80)', async () => {
    // a1: 10 de Poder, AGONY_FIXED (dano directo FIJO de 7, sin resolucion de
    // Ataque/Defensa ni dados). Se usa la variante FIJA deliberadamente: en
    // Combat CUALQUIER habilidad que no sea curacion/dano-directo/revivir se
    // resuelve como un "ataque mejorado" con su propia tirada (confirmado al
    // depurar esta prueba con STORM: aunque sus efectos son autobuffs de
    // Ataque/Dano, `SkillEffectPolicy` los clasifica igual como `kind:
    // 'DAMAGE'`, que exige objetivo rival y SI inflige dano real). Con
    // AGONY_FIXED la trayectoria entera queda 100% determinista.
    // b1: sin Ataque/Dano/habilidades -- su turno SIEMPRE resuelve por
    // END_TURN, sin dados, asi que el unico efecto observable de su turno es
    // abrir el de a1 de nuevo (Combatant.openOwnTurn(), +2 de Poder, HU-11).
    const room = battleWithCombat({
      profiles: {
        a1: combatProfileFixture({ maxPower: 10, abilities: [AGONY_FIXED] }),
        b1: combatProfileFixture({ attack: null, damage: null }),
      },
    })

    const result = await search().search(
      room,
      { ...MCTS_TEACHER_V1_CONFIG, rollouts: 4, maxDepthPlies: 2 },
      SEED,
    )

    const agonyFixedCandidate = result.candidates.find(
      (c) => c.action.kind === 'ABILITY' && c.action.abilityId === AGONY_FIXED_ID,
    )
    expect(agonyFixedCandidate).toBeDefined()

    // Ply 1 (a1 lanza Agonia fija): Poder 10 -> 7, Vida de b1 44 -> 37 (-7,
    // fijo, sin dados). Ply 2 (b1 sin acciones, END_TURN): cierra el turno de
    // b1 y ABRE el de a1, que regenera +2 -> Poder 9. maxDepthPlies=2 corta
    // justo ahi, sin terminar la batalla.
    // W=0.5 (no terminal), H=1 (a1 nunca fue atacado), P=9/10=0.9 (NO 7/10=0.7,
    // que seria el bug: quedarse solo con el gasto sin la regeneracion),
    // D=1-37/44=7/44 (dano fijo, sin dados: el mismo valor en todos los
    // rollouts que exploren esta candidata).
    const expectedUtility = 0.6 * 0.5 + 0.15 * 1 + 0.1 * 0.9 + 0.15 * (7 / 44)
    expect(agonyFixedCandidate?.meanUtility).toBeCloseTo(expectedUtility, 10)
  })

  it('M-15: si existen acciones legales pero ninguna es candidata estrategica, rechaza con NoStrategicMctsCandidatesError (bug #2 de la segunda revision de PR#80)', async () => {
    // Sanador 2v1: la unica accion de a1 es curar a a2, que ya esta a Vida
    // llena -- la regla de salud de EN-036 #555 dice que esa curacion NUNCA
    // es candidata estrategica. No hay ninguna otra opcion legal.
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: {
        a1: combatProfileFixture({
          attack: null,
          damage: null,
          maxPower: 10,
          abilities: [LIFE_TOUCH],
        }),
      },
      health: { 'A#1': 44 },
    })

    await expect(
      search().search(room, { ...MCTS_TEACHER_V1_CONFIG, rollouts: 4 }, SEED),
    ).rejects.toThrow(NoStrategicMctsCandidatesError)
  })

  it('M-16: en un contexto de Mision, restringe la raiz a la interseccion con MissionRotationConstraint', async () => {
    const room = battleWithSkills() // a1 tiene SHIELD_STRIKE/EMBATE/STORM/LOTUS/STONE_HAND + BASIC_ATTACK
    const legalActionGenerator = new LegalActionGenerator()
    const legalActionsAll = legalActionGenerator.generateAvailable(room)
    expect(legalActionsAll.length).toBeGreaterThan(1) // mas de una opcion real donde elegir

    // La rotacion configurada SOLO ofrece SHIELD_STRIKE: ninguna otra
    // habilidad ni el ataque basico deberian sobrevivir a la interseccion.
    const rotationInput: MissionRotationInput = {
      rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: STORM_ID }] }],
      cursors: new Map(),
      abilities: new Map([[STORM_ID, STORM]]),
      cooldowns: new Map(),
      power: 10,
      health: 44,
      maxHealth: 44,
      canAttack: true,
      enemyTarget: { scope: 'COMBATANT', combatant: { teamLabel: 'B', seat: 0 } },
    }

    const result = await search().search(
      room,
      { ...MCTS_TEACHER_V1_CONFIG, rollouts: 8 },
      SEED,
      rotationInput,
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.action).toEqual(
      expect.objectContaining({ kind: 'ABILITY', abilityId: STORM_ID }),
    )
  })

  it('completa 128 rollouts (configuracion v1 por defecto) en un tiempo razonable', async () => {
    const room = battleWithSkills()
    const start = Date.now()

    await search().search(room, MCTS_TEACHER_V1_CONFIG, SEED)

    expect(Date.now() - start).toBeLessThan(20_000)
  })
})
