import { RandomIndex } from '../../../domain/value-objects/RandomIndex'
import type { NormalToIndexMapper } from './RandomnessContracts'
import { standardNormalCdf } from './StandardNormalCdf'

/**
 * Estrategia de mapeo PROVISIONAL normal -> indice 1..8000 (HU-24).
 *
 *   Z ~ N(0,1)   ->   U = Phi(Z) ~ Uniforme(0,1)   ->   indice = floor(U * 8000) + 1
 *
 * POR QUE NO SE USA LA NORMAL DIRECTAMENTE COMO INDICE. La tabla de HU-25 esta
 * definida por FILAS: "4800 de 8000 filas = 60 %". Si el indice fuese una
 * normal N(4000.5, 1333.17), el rango 1..4800 recibiria ~72,4 - 72,6 % de las
 * tiradas y no 60 %. Con la transformacion integral de probabilidad (Phi) el
 * indice queda uniforme sobre las 8000 filas y cada fila pesa 1/8000.
 *
 * Es una DECISION TECNICA provisional, NO un requisito funcional confirmado:
 * RF-24 habla de una variable normal en [1, 8000]. Esta clase existe aparte de
 * MT19937 y de Box-Muller para que, si el PO o el profesor formalizan otra
 * lectura, se sustituya SOLO esta pieza (otra implementacion de
 * `NormalToIndexMapper`) sin tocar ni volver a probar el generador normal.
 *
 * Alternativas analizadas y descartadas (deforman la distribucion): recortar con
 * `clamp(normal, 1, 8000)` (acumula ~0,13 % de masa en cada extremo), `abs()`
 * (pliega la campana y duplica la densidad) y `normal % 8000` (envuelve las
 * colas sobre el otro extremo).
 */
export class CdfUniformIndexMapper implements NormalToIndexMapper {
  map(normal: number): RandomIndex {
    const uniform = standardNormalCdf(normal)

    // `uniform` puede valer exactamente 1 (Phi satura a 1 para z > ~8,3): sin el
    // `min`, `floor(1 * 8000) + 1` seria 8001. Se defiende el limite superior.
    const zeroBasedRow = Math.min(Math.floor(uniform * RandomIndex.MAX), RandomIndex.MAX - 1)

    return RandomIndex.create(zeroBasedRow + RandomIndex.MIN)
  }
}
