import {
  assertAttackDie,
  dieFaceFromIndex,
  type AttackDie,
  type AttackProfile,
} from '../../domain/policies/AttackProfile'
import {
  assertCombatValue,
  compareAttackAgainstDefense,
} from '../../domain/policies/AttackResolutionPolicy'
import type { EffectControlTable } from '../../domain/random-effects/EffectControlTable'
import type { ResolvedRandomEffect } from '../../domain/random-effects/ResolvedRandomEffect'
import type { RandomSequencePort } from '../ports/RandomSequencePort'
import { ResolveRandomEffect } from './ResolveRandomEffect'

export interface ResolveAttackInput {
  /** Ataque de este golpe: valor base y, si lo tiene, su dado (`prepareAttack` lo arma). */
  readonly attack: AttackProfile
  /** Defensa del objetivo. */
  readonly defenseValue: number
  /** Tabla de efectos del atacante para este golpe. Solo se consulta si el golpe es efectivo. */
  readonly table: EffectControlTable
  /** Secuencia de indices de la batalla o simulacion (HU-24), con su estado. */
  readonly sequence: RandomSequencePort
}

interface AttackResolutionBase {
  /** Ataque efectivo sin el dado. */
  readonly attackBase: number
  /** Lo que salio en el dado de Ataque (0 si no lleva dado). */
  readonly attackRoll: number
  /** `attackBase + attackRoll`: el valor que se comparo con la Defensa. */
  readonly attackValue: number
  readonly defenseValue: number
}

/**
 * Resultado consistente de un golpe (HU-20, CA-07): SIEMPRE dice si fue efectivo
 * y con que valores; `effect` solo existe si lo fue. Una union discriminada
 * impide leer un efecto de un golpe que no lo produjo.
 */
export type AttackResolution =
  | (AttackResolutionBase & { readonly effective: false; readonly effect: null })
  | (AttackResolutionBase & { readonly effective: true; readonly effect: ResolvedRandomEffect })

const rollAttackDice = (dice: AttackDie | null, sequence: RandomSequencePort): number => {
  if (dice === null) {
    return 0
  }

  let total = 0

  for (let roll = 0; roll < dice.count; roll += 1) {
    total += dieFaceFromIndex(sequence.nextIndex(), dice.sides)
  }

  return total
}

/**
 * Calcula el resultado de UN golpe: Ataque contra Defensa (HU-20, RF-20).
 *
 *   dado de Ataque  ->  Ataque = base + dado
 *   Ataque > Defensa ?
 *       no  ->  el golpe NO produce ningun efecto (CA-04); no se consulta la tabla
 *       si  ->  golpe efectivo (CA-05): UN indice mas -> `ResolveRandomEffect` (CA-06)
 *
 * Consumo de la secuencia, que es lo que hace predecible la batalla:
 *  - dado de Ataque: exactamente `dice.count` indices (0 si el Ataque no lleva dado);
 *  - golpe efectivo: exactamente UN indice mas, el del efecto;
 *  - golpe NO efectivo: ninguno mas, y `ResolveRandomEffect` no se invoca.
 * Toda la aleatoriedad sale de `RandomSequencePort.nextIndex()` (HU-24, RF-25
 * CA-07): no hay otra fuente, ni siquiera para el dado.
 *
 * Todo se valida ANTES de tirar: una entrada invalida lanza y deja la secuencia
 * donde estaba.
 *
 * NO calcula dano numerico, vida ni fin de turno (HU-18), ni elige objetivos o
 * equipos, ni conoce el jugador: recibe numeros y una tabla. Por eso sirve igual
 * a un heroe, a un enemigo de mision o a una simulacion. Tampoco esta expuesto
 * por HTTP: un cliente que aportara el Ataque o la Defensa podria manipular el
 * resultado (HU-24, CA-05). Sin consumidor de produccion todavia: no se registra
 * en `app.module.ts` hasta que HU-17/HU-18 definan el flujo de batalla.
 */
export class ResolveAttack {
  constructor(
    private readonly resolveRandomEffect: ResolveRandomEffect = new ResolveRandomEffect(),
  ) {}

  execute(input: ResolveAttackInput): AttackResolution {
    const { attack, defenseValue, table, sequence } = input

    assertCombatValue(attack.base, 'El Ataque base')
    assertCombatValue(defenseValue, 'El valor de Defensa')

    if (attack.dice !== null) {
      assertAttackDie(attack.dice)
    }

    const attackRoll = rollAttackDice(attack.dice, sequence)
    const comparison = compareAttackAgainstDefense(attack.base + attackRoll, defenseValue)
    const base: AttackResolutionBase = {
      attackBase: attack.base,
      attackRoll,
      attackValue: comparison.attackValue,
      defenseValue: comparison.defenseValue,
    }

    if (!comparison.effective) {
      return { ...base, effective: false, effect: null }
    }

    return {
      ...base,
      effective: true,
      effect: this.resolveRandomEffect.execute({ sequence, table }),
    }
  }
}
