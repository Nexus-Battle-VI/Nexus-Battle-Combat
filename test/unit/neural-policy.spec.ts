import type {
  BattleDecisionState,
  DecisionCombatant,
} from '../../src/domain/decision/BattleDecisionState'
import type { LegalAction } from '../../src/domain/decision/LegalAction'
import { NoLegalDecisionActionsError } from '../../src/domain/errors/DecisionContractErrors'
import {
  NeuralInferenceOutputError,
  NeuralInferenceTimeoutError,
} from '../../src/domain/errors/NeuralPolicyErrors'
import { NeuralPolicy } from '../../src/application/policies/NeuralPolicy'
import type { NeuralInferencePort } from '../../src/application/ports/NeuralInferencePort'
import {
  FEATURE_DIMENSION,
  FeatureEncoderV1,
} from '../../src/application/services/FeatureEncoderV1'

const combatant = (teamLabel: string, seat: number, health = 10): DecisionCombatant => ({
  identity: { teamLabel, seat },
  kind: 'HUMAN',
  heroSubtype: null,
  health: { current: health, max: 10 },
  power: null,
  attack: 10,
  defense: 5,
  damage: null,
  level: 1,
  cooldowns: [],
  abilities: [],
  epic: null,
  activeEffects: [],
  damageMemory: null,
})

const stateWithEnemies = (enemyCount: number): BattleDecisionState => ({
  schemaVersion: 1,
  context: { battleId: 'b1', mode: 'PVE', round: 1, turnsCompleted: 0 },
  actor: combatant('A', 0),
  allies: [],
  enemies: Array.from({ length: enemyCount }, (_v, i) => combatant('B', i, 5 + i)),
})

const legalActionsFor = (state: BattleDecisionState): LegalAction[] =>
  state.enemies.map((enemy) => ({
    kind: 'BASIC_ATTACK' as const,
    target: { scope: 'COMBATANT' as const, combatant: enemy.identity },
  }))

class FakeInferencePort implements NeuralInferencePort {
  calls: { features: Float32Array; count: number }[] = []

  constructor(
    private readonly behavior: (
      features: Float32Array,
      count: number,
    ) => Promise<Float32Array> | Float32Array,
  ) {}

  async score(candidateFeatures: Float32Array, candidateCount: number): Promise<Float32Array> {
    this.calls.push({ features: candidateFeatures, count: candidateCount })
    const result = this.behavior(candidateFeatures, candidateCount)
    return result instanceof Float32Array ? result : await result
  }
}

const TIMEOUT_MS = 50

describe('NeuralPolicy (EN-036.4, Management #568 §55)', () => {
  it('NP-01: 0 legalActions -> NoLegalDecisionActionsError', async () => {
    const port = new FakeInferencePort(() => new Float32Array(0))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)

    await expect(policy.decide(stateWithEnemies(0), [])).rejects.toBeInstanceOf(
      NoLegalDecisionActionsError,
    )
    expect(port.calls).toHaveLength(0)
  })

  it('NP-02: 1 legalAction -> el runtime recibe [1,72] y se devuelve esa accion', async () => {
    const port = new FakeInferencePort((_f, count) => new Float32Array(count).fill(0.5))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(1)
    const actions = legalActionsFor(state)

    const chosen = await policy.decide(state, actions)

    expect(chosen).toEqual(actions[0])
    expect(port.calls).toHaveLength(1)
    expect(port.calls[0]?.count).toBe(1)
    expect(port.calls[0]?.features.length).toBe(1 * FEATURE_DIMENSION)
  })

  it('NP-03: 3 legalActions -> el runtime recibe [3,72]', async () => {
    const port = new FakeInferencePort((_f, count) => new Float32Array(count).fill(0))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(3)
    const actions = legalActionsFor(state)

    await policy.decide(state, actions)

    expect(port.calls[0]?.count).toBe(3)
    expect(port.calls[0]?.features.length).toBe(3 * FEATURE_DIMENSION)
  })

  it('NP-04: scores [0.1, 0.9, 0.2] -> elige el indice 1', async () => {
    const port = new FakeInferencePort(() => new Float32Array([0.1, 0.9, 0.2]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(3)
    const actions = legalActionsFor(state)

    const chosen = await policy.decide(state, actions)

    expect(chosen).toEqual(actions[1])
  })

  it('NP-05: empate exacto [0.5, 0.5] -> elige la PRIMERA accion (tie-break #568 §27)', async () => {
    const port = new FakeInferencePort(() => new Float32Array([0.5, 0.5]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(2)
    const actions = legalActionsFor(state)

    const chosen = await policy.decide(state, actions)

    expect(chosen).toEqual(actions[0])
  })

  it('NP-06: output.length != legalActions.length -> error controlado', async () => {
    const port = new FakeInferencePort(() => new Float32Array([0.1, 0.2]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(3)
    const actions = legalActionsFor(state)

    await expect(policy.decide(state, actions)).rejects.toBeInstanceOf(NeuralInferenceOutputError)
  })

  it('NP-07: score NaN -> error controlado', async () => {
    const port = new FakeInferencePort(() => new Float32Array([0.1, Number.NaN]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(2)
    const actions = legalActionsFor(state)

    await expect(policy.decide(state, actions)).rejects.toBeInstanceOf(NeuralInferenceOutputError)
  })

  it('NP-08: score +Infinity -> error controlado', async () => {
    const port = new FakeInferencePort(() => new Float32Array([Number.POSITIVE_INFINITY, 0.1]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(2)
    const actions = legalActionsFor(state)

    await expect(policy.decide(state, actions)).rejects.toBeInstanceOf(NeuralInferenceOutputError)
  })

  it('NP-09: el runtime lanza -> error controlado (nunca una excepcion generica sin manejar)', async () => {
    const port = new FakeInferencePort(() => {
      throw new Error('runtime nativo caido')
    })
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(1)
    const actions = legalActionsFor(state)

    await expect(policy.decide(state, actions)).rejects.toThrow('runtime nativo caido')
  })

  it('NP-10: timeout -> NeuralInferenceTimeoutError, sin dejar una promesa sin manejar', async () => {
    const port = new FakeInferencePort(
      () =>
        new Promise((resolve) => {
          // `.unref()`: este timer de la fuente FALSA sigue vivo despues de
          // que el timeout de la politica ya rechazo (documentado a
          // proposito en NeuralPolicy: la inferencia nativa subyacente no
          // se cancela de verdad) -- sin esto deja el proceso de Jest
          // colgado esperandolo.
          setTimeout(() => {
            resolve(new Float32Array([0.1]))
          }, TIMEOUT_MS * 20).unref()
        }),
    )
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(1)
    const actions = legalActionsFor(state)

    await expect(policy.decide(state, actions)).rejects.toBeInstanceOf(NeuralInferenceTimeoutError)
  })

  it('NP-11: no muta state ni legalActions', async () => {
    const port = new FakeInferencePort((_f, count) => new Float32Array(count).fill(0.3))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(2)
    const actions = legalActionsFor(state)
    const stateBefore = JSON.stringify(state)
    const actionsBefore = JSON.stringify(actions)

    await policy.decide(state, actions)

    expect(JSON.stringify(state)).toBe(stateBefore)
    expect(JSON.stringify(actions)).toBe(actionsBefore)
  })

  it('NP-12: la accion devuelta pertenece EXACTAMENTE a legalActions (misma referencia)', async () => {
    const port = new FakeInferencePort(() => new Float32Array([0.1, 0.9]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(2)
    const actions = legalActionsFor(state)

    const chosen = await policy.decide(state, actions)

    expect(actions).toContain(chosen)
    expect(chosen).toBe(actions[1])
  })

  it('determinismo: misma state+legalActions+scores -> misma decision, sin RNG (#568 §97)', async () => {
    const port = new FakeInferencePort(() => new Float32Array([0.2, 0.7, 0.4]))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)
    const state = stateWithEnemies(3)
    const actions = legalActionsFor(state)

    const first = await policy.decide(state, actions)
    const second = await policy.decide(state, actions)

    expect(first).toEqual(second)
  })

  it('soporte sin Ataque: solo puntua las acciones legales reales, nunca inventa BASIC_ATTACK', async () => {
    const supportState: BattleDecisionState = {
      schemaVersion: 1,
      context: { battleId: 'b1', mode: 'PVE', round: 1, turnsCompleted: 0 },
      actor: {
        ...combatant('A', 0),
        attack: null,
        damage: null,
        power: { current: 10, max: 10 },
        abilities: [
          {
            abilityId: 'heal',
            powerCost: { mode: 'FIXED', amount: 3 },
            chargeTurns: 1,
            effects: [],
          },
        ],
      },
      allies: [combatant('A', 1, 2)],
      enemies: [combatant('B', 0)],
    }
    const healAction: LegalAction = {
      kind: 'ABILITY',
      abilityId: 'heal',
      target: { scope: 'COMBATANT', combatant: { teamLabel: 'A', seat: 1 } },
    }
    const port = new FakeInferencePort((_f, count) => new Float32Array(count).fill(1))
    const policy = new NeuralPolicy(new FeatureEncoderV1(), port, TIMEOUT_MS)

    const chosen = await policy.decide(supportState, [healAction])

    expect(chosen).toEqual(healAction)
    expect(port.calls[0]?.count).toBe(1)
  })
})
