/**
 * Vocabulario ofensivo que el chat censura (HU-13, moderacion).
 *
 * Lista CURADA, no exhaustiva: insultos y groserias de uso comun en el
 * espanol de Colombia, en minusculas y sin tildes. `ChatProfanityPolicy`
 * normaliza cada termino y cada palabra del mensaje de la misma forma (sin
 * tildes, sin letras repetidas consecutivas) antes de compararlos, asi que
 * aqui no hacen falta variantes de mayusculas, tildes ni alargamientos
 * (`puuuta`).
 *
 * Criterios para anadir un termino:
 * - Es ofensivo en practicamente cualquier contexto de una partida. Palabras
 *   con un significado comun no ofensivo (`perra`, `zorra`, `sapo`, `chimba`,
 *   `coño`, que sin tilde colisiona con `cono`, y `hp`, que en una partida
 *   suele significar puntos de vida) quedan fuera: censurarlas estropearia
 *   conversaciones normales.
 * - Se compara por PALABRA COMPLETA (mas plural en `s`/`es`), nunca como
 *   fragmento: `puta` no afecta a `computadora`, `disputa` ni `reputacion`.
 *
 * Es la UNICA lista del sistema para el chat: Web no filtra, solo pinta lo que
 * Combat difunde.
 */
export const CHAT_OFFENSIVE_TERMS: readonly string[] = [
  // "hijo de puta" y sus contracciones habituales.
  'hijueputa',
  'hijoeputa',
  'hijodeputa',
  'hijaeputa',
  'jueputa',
  'gueputa',
  'hpta',
  'hijueputica',
  // Insultos colombianos frecuentes.
  'malparido',
  'malparida',
  'gonorrea',
  'pirobo',
  'piroba',
  'careverga',
  'carechimba',
  'mamaguevo',
  'mamahuevo',
  'gueva',
  'guevon',
  'huevon',
  // Groserias generales.
  'puta',
  'puto',
  'putica',
  'marica',
  'marico',
  'maricon',
  'mierda',
  'verga',
  'pendejo',
  'pendeja',
  'cabron',
  'cabrona',
  'culiao',
  'culiado',
]
