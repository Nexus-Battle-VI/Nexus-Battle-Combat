import type { BoundedRandom } from '../../src/domain/policies/TurnOrderPolicy'
import {
  EXPERIENCE_ROLL_FACES,
  defeatKeyOf,
  rollExperienceFor,
  type ExperienceRollDefeat,
} from '../../src/domain/reward/ExperienceRollPolicy'

/**
 * Politica pura de la tirada de experiencia (HU-09,
 * `hu-09-experience-reward-v1` §5.1, Task HU-09.2).
 *
 * Lo que se comprueba aqui es lo que el contrato fija: UNA tirada por NPC
 * derrotado -- no una por mision --, `1d8` en `1..8`, el orden de la peticion
 * respetado, y que la unica fuente sea la instancia de `BoundedRandom` que se
 * inyecta.
 */

/** Fuente de azar de prueba: devuelve los valores dados y anota cada cota pedida. */
class ScriptedRandom implements BoundedRandom {
  readonly bounds: number[] = []
  private cursor = 0

  constructor(private readonly values: readonly number[]) {}

  nextInt(bound: number): number {
    this.bounds.push(bound)

    const value = this.values[this.cursor]
    this.cursor += 1

    if (value === undefined) {
      throw new Error('La secuencia de prueba se agoto: se pidio una tirada de mas.')
    }

    return value
  }
}

const defeat = (
  encounterId: string,
  enemyInstanceId: string,
  rivalRef = enemyInstanceId.split('#')[0] ?? 'rival',
): ExperienceRollDefeat => ({ encounterId, enemyInstanceId, rivalRef })

describe('rollExperienceFor', () => {
  it('el dado tiene 8 caras y se pide SIEMPRE la cota 8', () => {
    expect(EXPERIENCE_ROLL_FACES).toBe(8)

    const random = new ScriptedRandom([0, 7])
    rollExperienceFor([defeat('1', 'a#1'), defeat('1', 'a#2')], random)

    expect(random.bounds).toEqual([8, 8])
  })

  it('`nextInt` devuelve 0..7 y la cara del dado es 1..8 (el +1 del contrato)', () => {
    const rolls = rollExperienceFor(
      [defeat('1', 'a#1'), defeat('1', 'a#2')],
      new ScriptedRandom([0, 7]),
    )

    expect(rolls.map((roll) => roll.roll)).toEqual([1, 8])
  })

  it('UNA tirada por CADA derrota, no una por mision', () => {
    const random = new ScriptedRandom([3, 1, 5])
    const defeats = [defeat('1', 'sombra#1'), defeat('1', 'sombra#2'), defeat('5', 'guardian#1')]

    const rolls = rollExperienceFor(defeats, random)

    expect(rolls).toHaveLength(3)
    expect(random.bounds).toHaveLength(3)
  })

  it('dos instancias del MISMO arquetipo reciben tiradas independientes', () => {
    const rolls = rollExperienceFor(
      [defeat('1', 'sombra-corrompida#1'), defeat('1', 'sombra-corrompida#2')],
      new ScriptedRandom([0, 6]),
    )

    expect(rolls.map((roll) => roll.roll)).toEqual([1, 7])
    expect(rolls[0]?.enemyInstanceId).toBe('sombra-corrompida#1')
    expect(rolls[1]?.enemyInstanceId).toBe('sombra-corrompida#2')
  })

  it('respeta el ORDEN recibido: las tiradas salen del mismo cursor que el resto del proceso', () => {
    const defeats = [defeat('5', 'z#1'), defeat('1', 'a#1'), defeat('2', 'm#1')]

    const rolls = rollExperienceFor(defeats, new ScriptedRandom([2, 4, 6]))

    expect(rolls.map((roll) => roll.enemyInstanceId)).toEqual(['z#1', 'a#1', 'm#1'])
    expect(rolls.map((roll) => roll.roll)).toEqual([3, 5, 7])
  })

  it('conserva encounterId, enemyInstanceId y rivalRef de cada derrota', () => {
    const rolls = rollExperienceFor(
      [defeat('7', 'guardian-eterno#1', 'guardian-eterno')],
      new ScriptedRandom([4]),
    )

    expect(rolls[0]).toEqual({
      encounterId: '7',
      enemyInstanceId: 'guardian-eterno#1',
      rivalRef: 'guardian-eterno',
      roll: 5,
    })
  })

  it('no muta la entrada y devuelve cada tirada congelada', () => {
    const defeats = [defeat('1', 'a#1')]
    const rolls = rollExperienceFor(defeats, new ScriptedRandom([1]))

    expect(defeats[0]).not.toHaveProperty('roll')
    expect(Object.isFrozen(rolls[0])).toBe(true)
  })

  it('sin derrotas no consume azar (el lote vacio lo rechaza antes el caso de uso)', () => {
    const random = new ScriptedRandom([])

    expect(rollExperienceFor([], random)).toEqual([])
    expect(random.bounds).toEqual([])
  })

  it('cualquier secuencia de 0..7 produce una cara valida del dado', () => {
    const faces = Array.from({ length: 8 }, (_, index) => index)
    const rolls = rollExperienceFor(
      faces.map((index) => defeat('1', `enemigo#${String(index)}`)),
      new ScriptedRandom(faces),
    )

    expect(rolls.map((roll) => roll.roll)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rolls.every((roll) => roll.roll >= 1 && roll.roll <= EXPERIENCE_ROLL_FACES)).toBe(true)
  })
})

describe('defeatKeyOf', () => {
  it('identifica la derrota por INSTANCIA (encuentro + enemigo), no por arquetipo', () => {
    expect(defeatKeyOf(defeat('1', 'sombra-corrompida#1'))).toBe('1:sombra-corrompida#1')
    expect(defeatKeyOf(defeat('1', 'sombra-corrompida#1'))).toBe(
      defeatKeyOf(defeat('1', 'sombra-corrompida#1', 'otro-ref')),
    )
  })

  it('dos instancias del mismo arquetipo tienen claves distintas', () => {
    expect(defeatKeyOf(defeat('1', 'sombra-corrompida#1'))).not.toBe(
      defeatKeyOf(defeat('1', 'sombra-corrompida#2')),
    )
  })

  it('la misma instancia en encuentros distintos tiene claves distintas', () => {
    expect(defeatKeyOf(defeat('1', 'sombra-corrompida#1'))).not.toBe(
      defeatKeyOf(defeat('5', 'sombra-corrompida#1')),
    )
  })
})
