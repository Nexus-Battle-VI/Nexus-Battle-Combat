import type { EffectControlTable } from '../../domain/random-effects/EffectControlTable'
import type { ResolvedRandomEffect } from '../../domain/random-effects/ResolvedRandomEffect'
import type { RandomSequencePort } from '../ports/RandomSequencePort'

export interface ResolveRandomEffectInput {
  /** Secuencia de indices de la batalla o simulacion (HU-24), con su estado. */
  readonly sequence: RandomSequencePort
  /** Tabla vigente del heroe atacante, ya modificada por su equipamiento. */
  readonly table: EffectControlTable
}

/**
 * Resuelve el efecto aleatorio de UN golpe efectivo (HU-25, RF-25).
 *
 *   sequence.nextIndex()  ->  RandomIndex  ->  table.resolve()  ->  ResolvedRandomEffect
 *
 * Es el punto de union entre HU-24 (aleatoriedad) y HU-25 (tabla), y fija tres
 * garantias que ningun otro componente da por si solo:
 *
 *  - consume EXACTAMENTE UN indice por golpe efectivo, de modo que el avance de
 *    la secuencia de la batalla es predecible;
 *  - el indice es el UNICO selector: no hay ninguna otra fuente de
 *    aleatoriedad (RF-25, CA-07), y este caso de uso solo depende de
 *    `RandomSequencePort.nextIndex()`, nunca de la normal cruda ni de la semilla;
 *  - no decide SI el golpe es efectivo. Esa comparacion Ataque/Defensa es de
 *    HU-20 (`ResolveAttack`), que invoca este caso de uso solo cuando el
 *    Ataque supera la Defensa (un golpe no efectivo no consume el indice del
 *    EFECTO).
 *
 * La secuencia se recibe por llamada, no en el constructor, porque es un
 * objeto con estado que pertenece a cada batalla y no un servicio compartido.
 * Su unico consumidor es `ResolveAttack`, y ese aun no tiene consumidor de
 * produccion: no se registra en `app.module.ts` hasta que HU-17/HU-18 definan el
 * flujo de batalla.
 */
export class ResolveRandomEffect {
  execute(input: ResolveRandomEffectInput): ResolvedRandomEffect {
    return input.table.resolve(input.sequence.nextIndex())
  }
}
