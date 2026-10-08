import { createHash } from 'node:crypto'

/**
 * `evaluation-seed-schedule-v1` (EN-036.5, Management #569 §25-29): deriva
 * TODAS las semillas de una evaluacion a partir de un UNICO `matchSeed`
 * entero uint32, de forma determinista y SIN RNG (SHA-256, no
 * `Math.random`/`crypto.randomInt`/`Date.now`, #569 §26, §195 -- por eso
 * este archivo SI usa `node:crypto`, igual que
 * `NeuralModelArtifactLoader.ts`, y por el mismo motivo: hash de
 * integridad/derivacion, nunca aleatoriedad).
 *
 * Cada fuente de RNG del harness (RNG de Combat, RNG de `RandomPolicy` por
 * lado, semilla de MCTS por decision) se deriva con un namespace EXPLICITO
 * (#569 §27) para que nunca compartan secuencia entre si ni con el cursor
 * de Combat de una batalla real: "combat"/"turn-order"/"random-policy"/
 * "mcts" son namespaces disjuntos, cada uno con su propio espacio de
 * derivacion (nunca reutiliza el cursor `BATTLE_RANDOM` de #569 §27).
 */
export const EVALUATION_SEED_SCHEDULE_VERSION = 'evaluation-seed-schedule-v1'

const UINT32_MAX = 0xffff_ffff

/** Entero uniforme determinista en `[0, UINT32_MAX]` a partir de material textual. */
const deriveUint32 = (...parts: readonly (string | number)[]): number => {
  const material = [EVALUATION_SEED_SCHEDULE_VERSION, ...parts].join('|')
  const digest = createHash('sha256').update(material, 'utf8').digest()

  return digest.readUInt32BE(0)
}

export type EvaluationSide = 'A' | 'B'

/** Semilla de la UNICA `RandomSequencePort` de Combat para toda la partida. */
export const deriveCombatSeed = (matchSeed: number): number => deriveUint32('combat', matchSeed)

/** Semilla del `BoundedRandom` que decide el orden de turnos inicial. */
export const deriveTurnOrderSeed = (matchSeed: number): number =>
  deriveUint32('turn-order', matchSeed)

/**
 * Semilla de la secuencia de `RandomPolicy` reservada para UN LADO durante
 * TODA la partida (#569 §148: continua, nunca reiniciada por decision).
 * Se deriva por lado, no por politica: en un par espejado, el lado A juega
 * una politica en un leg y otra en el leg espejo, pero el namespace sigue
 * ligado al LADO -- si esa politica no es `RandomPolicy`, la semilla
 * simplemente no se consume.
 */
export const deriveRandomPolicySeed = (matchSeed: number, side: EvaluationSide): number =>
  deriveUint32('random-policy', matchSeed, side)

/**
 * Semilla de MCTS para UNA decision especifica (#569 §28: NUNCA la misma
 * `simulationSeed` en cada turno). `decisionIndex` cuenta solo decisiones
 * reales de politica (nunca los `SYSTEM_END_TURN` con 0 acciones legales).
 */
export const deriveMctsSeed = (
  matchSeed: number,
  side: EvaluationSide,
  decisionIndex: number,
): number => deriveUint32('mcts', matchSeed, side, decisionIndex)

/** Valida que `raw` sea un entero representable como semilla uint32 (#569 §26, §172-173). */
export const assertUint32Seed = (raw: number, label: string): number => {
  if (!Number.isInteger(raw) || raw < 0 || raw > UINT32_MAX) {
    throw new RangeError(
      `${label} debe ser un entero uint32 (0..${String(UINT32_MAX)}), recibido ${String(raw)}.`,
    )
  }

  return raw
}

/** Secuencia determinista `[seedStart, seedStart+1, ..., seedStart+seedCount-1]` (#569 §173). */
export const generateSeedSequence = (seedStart: number, seedCount: number): readonly number[] => {
  assertUint32Seed(seedStart, 'seedStart')
  if (!Number.isInteger(seedCount) || seedCount < 1) {
    throw new RangeError(`seedCount debe ser un entero >= 1, recibido ${String(seedCount)}.`)
  }

  const seeds: number[] = []
  for (let i = 0; i < seedCount; i += 1) {
    seeds.push(assertUint32Seed(seedStart + i, 'seedStart+i'))
  }

  return seeds
}
