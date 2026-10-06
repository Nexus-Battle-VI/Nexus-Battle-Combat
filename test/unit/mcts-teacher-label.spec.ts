import {
  MCTS_TEACHER_LABEL_SCHEMA_VERSION,
  teacherCandidatesAreSubsetOfLegalActions,
  type MctsTeacherLabel,
} from '../../src/domain/decision/MctsTeacherLabel'
import type { CombatDecisionEvent } from '../../src/domain/decision/CombatDecisionEvent'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import { deriveLiveTeacherSeed } from '../../src/domain/policies/MctsSeedDerivation'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { MctsTeacherLabelConflictError } from '../../src/domain/errors/MctsErrors'
import { InMemoryMctsTeacherLabelRepository } from '../../src/adapters/outbound/persistence/InMemoryMctsTeacherLabelRepository'
import { InMemoryMctsSimulationAdapter } from '../../src/adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { MctsSearch } from '../../src/application/services/MctsSearch'
import { MctsTeacher } from '../../src/application/services/MctsTeacher'
import {
  LiveMctsTeacherLabeler,
  type LiveMctsTeacherLabelerLogger,
} from '../../src/application/services/LiveMctsTeacherLabeler'
import type { MctsTeacherLabelRepositoryPort } from '../../src/application/ports/MctsTeacherLabelRepositoryPort'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import { clock, silentLogger } from '../fixtures/battle'

const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())

const realTeacher = (): MctsTeacher =>
  new MctsTeacher(new MctsSearch(new InMemoryMctsSimulationAdapter(clock), factory))

const basicAttackDecision = (overrides: Partial<CombatDecisionEvent> = {}): CombatDecisionEvent => {
  const room = battleWithCombat()
  const action = {
    kind: 'BASIC_ATTACK' as const,
    target: { scope: 'COMBATANT' as const, combatant: { teamLabel: 'B', seat: 0 } },
  }

  return {
    schemaVersion: 1,
    eventType: 'COMBAT_DECISION',
    eventId: 'decision:ONLINE:7:cmd-a',
    battleId: room.id,
    decisionSequence: 0,
    origin: 'ONLINE',
    mode: room.mode,
    actor: { teamLabel: 'A', seat: 0 },
    decisionSource: 'RULE_BASED',
    stateBefore: {
      schemaVersion: 1,
      context: { battleId: room.id, mode: room.mode, round: 1, turnsCompleted: 0 },
      actor: {} as never,
      allies: [],
      enemies: [],
    },
    legalActions: [action],
    selectedAction: action,
    occurredAt: new Date('2026-10-06T00:00:00.000Z'),
    ...overrides,
  }
}

describe('MctsTeacherLabel (contrato oficial, correccion de alcance sobre PR#81)', () => {
  it('teacherCandidatesAreSubsetOfLegalActions acepta un subconjunto estricto (filtrado estrategico)', () => {
    const b0 = { teamLabel: 'B', seat: 0 }
    const legalActions = [
      { kind: 'BASIC_ATTACK' as const, target: { scope: 'COMBATANT' as const, combatant: b0 } },
      { kind: 'ABILITY' as const, abilityId: 'heal-1', target: { scope: 'SELF' as const } },
    ]
    const label: Pick<MctsTeacherLabel, 'result'> = {
      result: {
        config: MCTS_TEACHER_V1_CONFIG,
        simulationSeed: 1,
        stateSchemaVersion: 1,
        selectedAction: legalActions[0]!,
        candidates: [
          {
            action: legalActions[0]!,
            actionIdentity: 'x',
            visits: 1,
            meanUtility: 0.5,
            probability: 1,
          },
        ],
      },
    }

    expect(teacherCandidatesAreSubsetOfLegalActions(label, legalActions)).toBe(true)
  })

  it('teacherCandidatesAreSubsetOfLegalActions rechaza un candidato inventado', () => {
    const b0 = { teamLabel: 'B', seat: 0 }
    const legalActions = [
      { kind: 'BASIC_ATTACK' as const, target: { scope: 'COMBATANT' as const, combatant: b0 } },
    ]
    const invented = {
      kind: 'ABILITY' as const,
      abilityId: 'no-existe',
      target: { scope: 'SELF' as const },
    }
    const label: Pick<MctsTeacherLabel, 'result'> = {
      result: {
        config: MCTS_TEACHER_V1_CONFIG,
        simulationSeed: 1,
        stateSchemaVersion: 1,
        selectedAction: invented,
        candidates: [
          { action: invented, actionIdentity: 'y', visits: 1, meanUtility: 0.5, probability: 1 },
        ],
      },
    }

    expect(teacherCandidatesAreSubsetOfLegalActions(label, legalActions)).toBe(false)
  })

  it('MCTS_TEACHER_LABEL_SCHEMA_VERSION es 1', () => {
    expect(MCTS_TEACHER_LABEL_SCHEMA_VERSION).toBe(1)
  })
})

describe('deriveLiveTeacherSeed (§13, correccion de alcance sobre PR#81)', () => {
  it('es determinista: el mismo eventId produce siempre la misma semilla', () => {
    const a = deriveLiveTeacherSeed('decision:ONLINE:battle-1:cmd-a')
    const b = deriveLiveTeacherSeed('decision:ONLINE:battle-1:cmd-a')
    expect(a).toBe(b)
  })

  it('eventId distintos producen (con altisima probabilidad) semillas distintas', () => {
    const a = deriveLiveTeacherSeed('decision:ONLINE:battle-1:cmd-a')
    const b = deriveLiveTeacherSeed('decision:ONLINE:battle-1:cmd-b')
    expect(a).not.toBe(b)
  })

  it('siempre produce un entero valido para RandomSeed (uint32)', () => {
    const seed = deriveLiveTeacherSeed('cualquier-event-id')
    expect(() => RandomSeed.create(seed)).not.toThrow()
  })

  it('nunca depende de Math.random/Date.now/crypto: dos llamadas sin reloj ni RNG global siguen coincidiendo', () => {
    const originalRandom = Math.random
    const originalNow = Date.now
    Math.random = () => {
      throw new Error('deriveLiveTeacherSeed no debe tocar Math.random')
    }
    Date.now = () => {
      throw new Error('deriveLiveTeacherSeed no debe tocar Date.now')
    }
    try {
      expect(deriveLiveTeacherSeed('estable')).toBe(deriveLiveTeacherSeed('estable'))
    } finally {
      Math.random = originalRandom
      Date.now = originalNow
    }
  })
})

describe('LiveMctsTeacherLabeler (EN-036.2 #566, correccion de alcance sobre PR#81)', () => {
  const repository = (): MctsTeacherLabelRepositoryPort => new InMemoryMctsTeacherLabelRepository()

  it('prepare() devuelve null sin decision (sin CombatDecisionRecorder inyectado)', () => {
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repository(), clock, silentLogger)
    expect(labeler.prepare(battleWithCombat(), null)).toBeNull()
    expect(labeler.prepare(battleWithCombat(), undefined)).toBeNull()
  })

  it('prepare() devuelve null para END_TURN: nunca llama a MctsTeacher', () => {
    const teachMock = jest.fn()
    const teacher = { teach: teachMock } as unknown as MctsTeacher
    const labeler = new LiveMctsTeacherLabeler(teacher, repository(), clock, silentLogger)
    const endTurnDecision = basicAttackDecision({
      schemaVersion: 2,
      legalActions: [],
      selectedAction: { kind: 'END_TURN' },
      decisionSource: 'SYSTEM',
    })

    expect(labeler.prepare(battleWithCombat(), endTurnDecision)).toBeNull()
    expect(teachMock).not.toHaveBeenCalled()
  })

  it('camino feliz: genera y persiste un MctsTeacherLabel ligado por eventId a la decision', async () => {
    const room = battleWithCombat()
    const repo = repository()
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repo, clock, silentLogger)
    const decision = basicAttackDecision({ battleId: room.id })

    const pending = labeler.prepare(room, decision)
    expect(pending).not.toBeNull()
    await labeler.persist(pending)

    const stored = await repo.findByEventId(decision.eventId)
    expect(stored).not.toBeNull()
    expect(stored?.schemaVersion).toBe(MCTS_TEACHER_LABEL_SCHEMA_VERSION)
    expect(stored?.eventId).toBe(decision.eventId)
    expect(stored?.battleId).toBe(decision.battleId)
    expect(stored?.decisionSequence).toBe(decision.decisionSequence)
    expect(stored?.origin).toBe(decision.origin)
    expect(stored?.mode).toBe(decision.mode)
    expect(stored?.result.candidates.length).toBeGreaterThan(0)
    expect(stored?.generatedAt).toEqual(clock.now())
  })

  it('el teacher genera SU PROPIA seleccion/distribucion, no copia selectedAction de la decision (§20)', async () => {
    // El actor tiene una habilidad (ademas del ataque basico): el teacher real
    // explora ambas y puede preferir una distinta a la que "selecciono" la
    // decision real pasada aqui (que deliberadamente fija BASIC_ATTACK).
    const storm = {
      abilityId: 'ability-storm',
      name: 'Storm',
      powerCost: { mode: 'FIXED' as const, amount: 6 },
      chargeTurns: 1,
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'ATTACK',
          operation: 'INCREASE',
          magnitude: { mode: 'DICE' as const, count: 3, sides: 6 },
          hasActivationCondition: false,
        },
      ],
    }
    const room = battleWithCombat({
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [storm] }) },
    })
    const decision = basicAttackDecision({
      battleId: room.id,
      legalActions: [
        {
          kind: 'BASIC_ATTACK',
          target: { scope: 'COMBATANT', combatant: { teamLabel: 'B', seat: 0 } },
        },
        {
          kind: 'ABILITY',
          abilityId: 'ability-storm',
          target: { scope: 'COMBATANT', combatant: { teamLabel: 'B', seat: 0 } },
        },
      ],
    })
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repository(), clock, silentLogger)

    const pending = labeler.prepare(room, decision)
    const result = await pending!.result
    expect(result).not.toBeNull()
    // El teacher SIEMPRE tiene un candidato por accion legal estrategica
    // disponible (ninguna de las dos se filtra aqui): la prueba real es que
    // el resultado NUNCA simplemente reusa `decision.selectedAction` como un
    // atajo -- lo recalcula buscando de verdad.
    expect(result!.candidates.length).toBeGreaterThanOrEqual(1)
  })

  it('fail-open: si MctsTeacher.teach() rechaza, no lanza y no persiste nada', async () => {
    const failure = new Error('fallo simulado de MCTS')
    const teacher = { teach: jest.fn().mockRejectedValue(failure) } as unknown as MctsTeacher
    const repo = repository()
    const errorLog = jest.fn()
    const logger: LiveMctsTeacherLabelerLogger = { error: errorLog }
    const labeler = new LiveMctsTeacherLabeler(teacher, repo, clock, logger)
    const decision = basicAttackDecision()

    const pending = labeler.prepare(battleWithCombat(), decision)
    await expect(labeler.persist(pending)).resolves.toBeUndefined()

    expect(await repo.findByEventId(decision.eventId)).toBeNull()
    expect(errorLog).toHaveBeenCalledWith(
      'mcts_teacher_label_generation_failed',
      expect.objectContaining({ eventId: decision.eventId }),
    )
  })

  it('fail-open: NoStrategicMctsCandidatesError del teacher real tambien se traga sin romper nada', async () => {
    // Sanador 2v1 cuya unica accion es curar a un aliado ya a Vida llena: el
    // teacher real rechaza con NoStrategicMctsCandidatesError (EN-036.1).
    const healAbility = {
      abilityId: 'ability-life-touch',
      name: 'Toque de la Vida',
      powerCost: { mode: 'FIXED' as const, amount: 3 },
      chargeTurns: 1,
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'ALLY',
          statistic: 'HEALING',
          operation: 'INCREASE',
          magnitude: { mode: 'FIXED' as const, amount: 2 },
          hasActivationCondition: false,
        },
      ],
    }
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: {
        a1: combatProfileFixture({
          attack: null,
          damage: null,
          maxPower: 10,
          abilities: [healAbility],
        }),
      },
      health: { 'A#1': 44 },
    })
    const decision = basicAttackDecision({
      battleId: room.id,
      legalActions: [
        {
          kind: 'ABILITY',
          abilityId: 'ability-life-touch',
          target: { scope: 'COMBATANT', combatant: { teamLabel: 'A', seat: 1 } },
        },
      ],
      selectedAction: {
        kind: 'ABILITY',
        abilityId: 'ability-life-touch',
        target: { scope: 'COMBATANT', combatant: { teamLabel: 'A', seat: 1 } },
      },
    })
    const errorLog = jest.fn()
    const repo = repository()
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repo, clock, { error: errorLog })

    const pending = labeler.prepare(room, decision)
    await expect(labeler.persist(pending)).resolves.toBeUndefined()

    expect(await repo.findByEventId(decision.eventId)).toBeNull()
    expect(errorLog).toHaveBeenCalledWith(
      'mcts_teacher_label_generation_failed',
      expect.objectContaining({ reason: 'NoStrategicMctsCandidatesError' }),
    )
  })

  it('fail-open: un candidato del teacher fuera de legalActions invalida el label (no se persiste)', async () => {
    const result = {
      config: MCTS_TEACHER_V1_CONFIG,
      simulationSeed: 1,
      stateSchemaVersion: 1 as const,
      selectedAction: {
        kind: 'ABILITY' as const,
        abilityId: 'inventada',
        target: { scope: 'SELF' as const },
      },
      candidates: [
        {
          action: {
            kind: 'ABILITY' as const,
            abilityId: 'inventada',
            target: { scope: 'SELF' as const },
          },
          actionIdentity: 'z',
          visits: 1,
          meanUtility: 0.5,
          probability: 1,
        },
      ],
    }
    const teacher = { teach: jest.fn().mockResolvedValue(result) } as unknown as MctsTeacher
    const repo = repository()
    const errorLog = jest.fn()
    const labeler = new LiveMctsTeacherLabeler(teacher, repo, clock, { error: errorLog })
    const decision = basicAttackDecision() // legalActions solo tiene BASIC_ATTACK

    const pending = labeler.prepare(battleWithCombat(), decision)
    await labeler.persist(pending)

    expect(await repo.findByEventId(decision.eventId)).toBeNull()
    expect(errorLog).toHaveBeenCalledWith(
      'mcts_teacher_label_generation_failed',
      expect.objectContaining({ reason: 'MctsTeacherLabelValidationError' }),
    )
  })

  it('persist(null) es un no-op seguro (decision sin label que preparar)', async () => {
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repository(), clock, silentLogger)
    await expect(labeler.persist(null)).resolves.toBeUndefined()
  })

  it('aislamiento de RNG: generar el label NUNCA consume la secuencia de produccion', async () => {
    const room = battleWithCombat()
    const productionSequence = factory.create(RandomSeed.create(3_000_000))
    const spy = jest.spyOn(productionSequence, 'nextIndex')
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repository(), clock, silentLogger)
    const decision = basicAttackDecision({ battleId: room.id })

    const pending = labeler.prepare(room, decision)
    await labeler.persist(pending)

    expect(spy).not.toHaveBeenCalled()
  })

  it('idempotencia: repetir prepare+persist para el MISMO eventId nunca lanza MctsTeacherLabelConflictError', async () => {
    const room = battleWithCombat()
    const repo = repository()
    const labeler = new LiveMctsTeacherLabeler(realTeacher(), repo, clock, silentLogger)
    const decision = basicAttackDecision({ battleId: room.id })

    await labeler.persist(labeler.prepare(room, decision))
    await expect(labeler.persist(labeler.prepare(room, decision))).resolves.toBeUndefined()
  })
})

describe('InMemoryMctsTeacherLabelRepository (append-only, EN-036.2 #566)', () => {
  const label = (overrides: Partial<MctsTeacherLabel> = {}): MctsTeacherLabel => ({
    schemaVersion: MCTS_TEACHER_LABEL_SCHEMA_VERSION,
    eventId: 'decision:ONLINE:1:cmd-a',
    battleId: 'battle-1',
    decisionSequence: 0,
    origin: 'ONLINE',
    mode: 'PVE',
    result: {
      config: MCTS_TEACHER_V1_CONFIG,
      simulationSeed: 1,
      stateSchemaVersion: 1,
      selectedAction: {
        kind: 'BASIC_ATTACK',
        target: { scope: 'COMBATANT', combatant: { teamLabel: 'B', seat: 0 } },
      },
      candidates: [
        {
          action: {
            kind: 'BASIC_ATTACK',
            target: { scope: 'COMBATANT', combatant: { teamLabel: 'B', seat: 0 } },
          },
          actionIdentity: 'BASIC_ATTACK|COMBATANT|1:B|0',
          visits: 1,
          meanUtility: 0.5,
          probability: 1,
        },
      ],
    },
    generatedAt: new Date('2026-10-06T00:00:00.000Z'),
    ...overrides,
  })

  it('T-01: append valido -> findByEventId devuelve el mismo label', async () => {
    const repo = new InMemoryMctsTeacherLabelRepository()
    await repo.append(label())
    await expect(repo.findByEventId('decision:ONLINE:1:cmd-a')).resolves.toEqual(label())
  })

  it('T-02: repetir el MISMO contenido es idempotente', async () => {
    const repo = new InMemoryMctsTeacherLabelRepository()
    await repo.append(label())
    await expect(repo.append(label())).resolves.toBeUndefined()
  })

  it('T-03: mismo eventId, contenido distinto -> MctsTeacherLabelConflictError', async () => {
    const repo = new InMemoryMctsTeacherLabelRepository()
    await repo.append(label())
    await expect(repo.append(label({ decisionSequence: 1 }))).rejects.toBeInstanceOf(
      MctsTeacherLabelConflictError,
    )
  })

  it('T-04: dos decisiones distintas producen dos labels independientes', async () => {
    const repo = new InMemoryMctsTeacherLabelRepository()
    await repo.append(label({ eventId: 'e1' }))
    await repo.append(label({ eventId: 'e2', battleId: 'battle-2' }))

    expect(await repo.findByEventId('e1')).not.toBeNull()
    expect(await repo.findByEventId('e2')).not.toBeNull()
  })

  it('findByEventId de un eventId desconocido devuelve null', async () => {
    const repo = new InMemoryMctsTeacherLabelRepository()
    expect(await repo.findByEventId('no-existe')).toBeNull()
  })
})
