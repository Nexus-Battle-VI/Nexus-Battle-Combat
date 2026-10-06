import type { LegalAction } from '../../src/domain/decision/LegalAction'
import {
  HEALING_STRATEGIC_THRESHOLD,
  filterStrategicCandidates,
} from '../../src/application/services/MctsStrategicCandidateFilter'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import { LIFE_TOUCH, LIFE_TOUCH_ID, FOREST_SONG, FOREST_SONG_ID } from '../fixtures/skills'

const ROOT_ACTOR = { teamLabel: 'A', seat: 0 }
const ALLY = { teamLabel: 'A', seat: 1 }

const basicAttackOn = (target: typeof ALLY): LegalAction => ({
  kind: 'BASIC_ATTACK',
  target: { scope: 'COMBATANT', combatant: target },
})

const healAbilityOn = (target: typeof ALLY): LegalAction => ({
  kind: 'ABILITY',
  abilityId: LIFE_TOUCH_ID,
  target: { scope: 'COMBATANT', combatant: target },
})

const healAlliedGroup = (): LegalAction => ({
  kind: 'ABILITY',
  abilityId: FOREST_SONG_ID,
  target: { scope: 'ALLIED_GROUP' },
})

describe('filterStrategicCandidates (regla de salud, EN-036 #555, fix de PR#80)', () => {
  it('una curacion sobre un aliado por debajo del umbral (90%) sigue siendo candidata', () => {
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [LIFE_TOUCH] }) },
      health: { 'A#1': 10 }, // a2 con 10/44 ~= 23%: muy por debajo de 0.90
    })
    const legalActions = [basicAttackOn({ teamLabel: 'B', seat: 0 }), healAbilityOn(ALLY)]

    const result = filterStrategicCandidates(room, ROOT_ACTOR, legalActions)

    expect(result).toEqual(legalActions)
  })

  it('una curacion sobre un aliado por encima del umbral se descarta como candidata', () => {
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [LIFE_TOUCH] }) },
      health: { 'A#1': 44 }, // a2 a Vida llena: curarlo es un desperdicio
    })
    const attack = basicAttackOn({ teamLabel: 'B', seat: 0 })
    const heal = healAbilityOn(ALLY)

    const result = filterStrategicCandidates(room, ROOT_ACTOR, [attack, heal])

    expect(result).toEqual([attack])
  })

  it('exactamente en el umbral (90%) ya NO es candidata (>= descarta)', () => {
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [LIFE_TOUCH] }) },
      health: { 'A#1': Math.round(44 * HEALING_STRATEGIC_THRESHOLD) },
    })
    const attack = basicAttackOn({ teamLabel: 'B', seat: 0 })
    const heal = healAbilityOn(ALLY)

    const result = filterStrategicCandidates(room, ROOT_ACTOR, [attack, heal])

    expect(result).toEqual([attack])
  })

  it('una curacion de grupo sigue siendo candidata si AL MENOS un aliado esta por debajo del umbral', () => {
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [FOREST_SONG] }) },
      health: { 'A#1': 5 },
    })
    const legalActions = [basicAttackOn({ teamLabel: 'B', seat: 0 }), healAlliedGroup()]

    const result = filterStrategicCandidates(room, ROOT_ACTOR, legalActions)

    expect(result).toEqual(legalActions)
  })

  it('una curacion de grupo se descarta solo si TODO el grupo ya esta por encima del umbral', () => {
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [FOREST_SONG] }) },
      health: { 'A#1': 44 },
    })
    const attack = basicAttackOn({ teamLabel: 'B', seat: 0 })
    const heal = healAlliedGroup()

    const result = filterStrategicCandidates(room, ROOT_ACTOR, [attack, heal])

    expect(result).toEqual([attack])
  })

  it('una accion que no es curacion nunca se filtra, sin importar la Vida de nadie', () => {
    const room = battleWithCombat({ health: { 'B#0': 44 } })
    const legalActions = [basicAttackOn({ teamLabel: 'B', seat: 0 })]

    expect(filterStrategicCandidates(room, ROOT_ACTOR, legalActions)).toEqual(legalActions)
  })

  it('si TODAS las candidatas fueran curaciones desperdiciadas, el resultado queda VACIO (corregido tras la segunda revision de PR#80)', () => {
    // La regla de salud de EN-036 #555 es categorica: si el unico receptor
    // posible ya esta a Vida llena, esa curacion NO es una candidata
    // estrategica, punto. Reintroducirla para que MCTS "tenga algo que
    // explorar" violaria la regla en vez de respetarla; es responsabilidad
    // de MctsSearch.search() decidir que hacer ante una lista vacia
    // (NoStrategicMctsCandidatesError), no de este filtro.
    const room = battleWithCombat({
      teamSizes: [2, 1],
      profiles: { a1: combatProfileFixture({ maxPower: 10, abilities: [LIFE_TOUCH] }) },
      health: { 'A#1': 44 },
    })
    const onlyHeal = [healAbilityOn(ALLY)]

    expect(filterStrategicCandidates(room, ROOT_ACTOR, onlyHeal)).toEqual([])
  })
})
