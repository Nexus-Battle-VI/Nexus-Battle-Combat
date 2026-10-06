import { RandomSeed } from '../value-objects/RandomSeed'
import { InvalidMctsConfigError } from '../errors/MctsErrors'

/**
 * Deriva la semilla de UN rollout de MCTS (EN-036.1, Management Task #565,
 * §22) a partir de una semilla raiz y su indice, de forma pura, determinista
 * y SIN `node:crypto`: este modulo vive en `src/domain/policies/` y una capa
 * de dominio no puede depender de adaptadores/infraestructura (regla de
 * capas de `eslint.config.mjs`), que es donde vive el unico precedente HMAC
 * del repositorio (`HmacMissionSeedFactory`). Ese precedente resuelve un
 * requisito de IMPREVISIBILIDAD (anti-fraude de misiones); aqui no existe tal
 * requisito, solo independencia ESTADISTICA entre rollouts de una misma
 * busqueda, para lo que un mezclador entero determinista basta y es
 * trivialmente auditable/reproducible.
 *
 * Mezclador estilo splitmix32: dos rondas de `(x ^ (x >>> 16)) * constante`
 * difunden bits suficientemente como para que semillas de rollout
 * consecutivas (`index = 0,1,2,...`) no guarden ninguna correlacion visible
 * entre si ni con la semilla raiz.
 */
const mixUint32 = (seed: number): number => {
  let x = seed >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * `rootSeed`: semilla del `MctsTeacherResult` completo (§22, se persiste en
 * `simulationSeed` para reproducibilidad). `rolloutIndex`: `0..rollouts-1`,
 * un entero distinto por cada simulacion de la busqueda.
 */
export const deriveMctsRolloutSeed = (rootSeed: number, rolloutIndex: number): RandomSeed => {
  if (!Number.isInteger(rolloutIndex) || rolloutIndex < 0) {
    throw new InvalidMctsConfigError(`indice de rollout invalido (${String(rolloutIndex)}).`)
  }

  const rootComponent = mixUint32(rootSeed)
  const indexComponent = mixUint32(rolloutIndex + 0x9e3779b1)
  return RandomSeed.create(mixUint32(rootComponent ^ indexComponent))
}
