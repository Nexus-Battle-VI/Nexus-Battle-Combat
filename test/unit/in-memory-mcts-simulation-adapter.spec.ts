import { InMemoryMctsSimulationAdapter } from '../../src/adapters/outbound/system/InMemoryMctsSimulationAdapter'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { SimulationTransitionError } from '../../src/domain/errors/MctsErrors'
import { battleWithCombat, combatProfileFixture } from '../fixtures/basic-attack'
import { clock } from '../fixtures/battle'

const factory = new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())

describe('InMemoryMctsSimulationAdapter (EN-036.1)', () => {
  it('applyAction nunca muta la sala recibida; devuelve un clon con la accion aplicada', async () => {
    const adapter = new InMemoryMctsSimulationAdapter(clock)
    const room = battleWithCombat()
    const before = room.toSnapshot()
    const actor = {
      teamLabel: room.battle!.currentEntry.teamLabel,
      seat: room.battle!.currentEntry.seat,
    }
    const target = room.battle!.turnOrder.find((e) => e.teamLabel !== actor.teamLabel)!
    const sequence = factory.create(RandomSeed.create(3_000_000))

    const result = await adapter.applyAction(
      room,
      actor,
      { kind: 'BASIC_ATTACK', target: { scope: 'COMBATANT', combatant: target } },
      'mcts:test:0',
      sequence,
    )

    expect(room.toSnapshot()).toEqual(before)
    expect(result.room).not.toBe(room)
    expect(result.room.events.length).toBeGreaterThan(room.events.length)
  })

  it('applyEndTurn avanza el turno sin consumir ningun sorteo', async () => {
    const adapter = new InMemoryMctsSimulationAdapter(clock)
    // Perfil sin Ataque/Dano/Poder ni habilidades: el unico camino es END_TURN.
    const room = battleWithCombat({
      profiles: { a1: combatProfileFixture({ attack: null, damage: null }) },
    })

    const result = await adapter.applyEndTurn(room, 'mcts:test:end')

    expect(result.finished).toBe(false)
    expect(result.room.battle?.currentEntry.teamLabel).not.toBe(room.battle?.currentEntry.teamLabel)
  })

  it('un commandId ya presente en el clon (handledCommands) se trata como defecto del arnes, no como repeticion silenciosa', async () => {
    const adapter = new InMemoryMctsSimulationAdapter(clock)
    const room = battleWithCombat()
    const actor = {
      teamLabel: room.battle!.currentEntry.teamLabel,
      seat: room.battle!.currentEntry.seat,
    }
    const target = room.battle!.turnOrder.find((e) => e.teamLabel !== actor.teamLabel)!
    const action = {
      kind: 'BASIC_ATTACK' as const,
      target: { scope: 'COMBATANT' as const, combatant: target },
    }

    const sequenceA = factory.create(RandomSeed.create(1))
    const first = await adapter.applyAction(room, actor, action, 'mcts:dup:0', sequenceA)

    // `first.room` ya trae `mcts:dup:0` en `handledCommands`: reusar ese mismo
    // commandId sobre ese clon es exactamente la situacion que el arnes de
    // busqueda nunca debe producir (cada ply usa un commandId nuevo).
    const sequenceB = factory.create(RandomSeed.create(2))
    await expect(
      adapter.applyAction(first.room, actor, action, 'mcts:dup:0', sequenceB),
    ).rejects.toThrow(SimulationTransitionError)
  })
})
