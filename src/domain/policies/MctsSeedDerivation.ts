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

/**
 * FNV-1a de 32 bits (dominio publico, sin `node:crypto`: misma restriccion de
 * capas que `mixUint32` de arriba). Pliega una cadena arbitraria a un unico
 * entero de 32 bits; no es criptografico, solo necesita evitar colisiones
 * triviales entre `eventId` distintos, que es exactamente lo que FNV-1a
 * garantiza para este uso.
 */
const fnv1a32 = (text: string): number => {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return hash >>> 0
}

/**
 * Deriva la `simulationSeed` RAIZ del teacher label en vivo (EN-036.2 #566,
 * correccion de alcance sobre PR#81, §13) a partir del `eventId` de la
 * decision real -- NUNCA de `BATTLE_RANDOM_SEQUENCE`, `Math.random`,
 * `Date.now` ni `crypto.randomInt`. El mismo `eventId` produce SIEMPRE la
 * misma semilla (reproducibilidad del label); esto no es RNG productivo, no
 * mueve ningun cursor de batalla ni de ninguna otra simulacion.
 *
 * Devuelve el entero crudo (no `RandomSeed`): `MctsTeacher.teach(room,
 * simulationSeed: number, ...)` lo valida el mismo con `RandomSeed.create`
 * internamente; `RandomSeed.create` se llama aqui solo para confirmar, con
 * el mismo contrato, que `mixUint32` nunca produce un valor fuera de rango.
 */
export const deriveLiveTeacherSeed = (eventId: string): number =>
  RandomSeed.create(mixUint32(fnv1a32(eventId))).value
