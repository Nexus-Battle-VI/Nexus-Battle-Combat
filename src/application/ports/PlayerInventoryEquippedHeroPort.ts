/**
 * Heroe equipado resuelto de Player-Inventory (HU-15.2, RF-15, DP-4).
 *
 * Espejo del contrato `GET /api/internal/v1/players/:playerId/equipped-hero`
 * (`@InternalOnly()`, rama `feat/hu-15-equipped-hero-internal-contract` de
 * Nexus-Battle-Player-Inventory): `{ playerId, heroId, reference, subtype,
 * name, baseStats, effectiveStats, ready, selectedAt }`.
 *
 * SIN `level`: confirmado por Player-Inventory que el dato no existe en su
 * dominio (DP-3). Combat NO LO INVENTA aqui tampoco -- ver el informe final
 * de esta tarea, seccion DP-3, para la traza hacia HU-15.4.
 *
 * Combat solo necesita `playerId`/`heroId` para resolver el `Participant`;
 * el resto del contrato (`reference`, `subtype`, `baseStats`,
 * `effectiveStats`, `ready`, `selectedAt`) NO SE MODELA aqui porque HU-15.2
 * no lo usa (HU-16 validara equipamiento de combate, no esta version).
 */
export interface EquippedHero {
  readonly playerId: string
  readonly heroId: string
}

/**
 * Puerto de salida hacia el contrato interno de Player-Inventory. La
 * implementacion HTTP concreta vive en
 * `adapters/outbound/http/PlayerInventoryHttpClient.ts`.
 */
export interface PlayerInventoryEquippedHeroPort {
  /**
   * Resuelve el heroe equipado de `playerId` (siempre `identity.subject`).
   *
   * Devuelve `null` cuando Player-Inventory responde 404 -- A DIFERENCIA de
   * `AccountBattleProfilePort.getBattleProfile()`, esto SI es un camino de
   * negocio valido: un jugador autenticado puede no tener ningun heroe
   * equipado todavia. `JoinBattleRoom` decide que hacer con `null` (ver
   * `PlayerWithoutEquippedHeroError`).
   */
  getEquippedHero(playerId: string): Promise<EquippedHero | null>
}

export const PLAYER_INVENTORY_EQUIPPED_HERO = Symbol('PlayerInventoryEquippedHeroPort')
