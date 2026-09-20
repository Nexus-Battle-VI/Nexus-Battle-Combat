import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  EquippedHero,
  PlayerInventoryEquippedHeroPort,
} from '../../../application/ports/PlayerInventoryEquippedHeroPort'
import { getInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'player-inventory'

/**
 * Cliente del contrato interno de Player-Inventory (HU-15.2, RF-15, DP-4):
 * `GET /api/internal/v1/players/:playerId/equipped-hero`, protegido con
 * `@InternalOnly()` + `InternalServiceGuard` HMAC (rama
 * `feat/hu-15-equipped-hero-internal-contract`).
 *
 * Player-Inventory monta TODAS sus rutas -incluidas las internas
 * `@InternalOnly()`- bajo su prefijo global (`app.setGlobalPrefix(config.globalPrefix)`
 * en `Nexus-Battle-Player-Inventory/src/main.ts`, `GLOBAL_PREFIX=api` por
 * defecto, sin excepcion para el contrato interno): `/api` es, por tanto,
 * parte del contrato, igual que ya lo trata `AccountHttpClient` para Account
 * (mismo defecto, ya corregido alli en Combat PR#12). Corregido en la
 * auditoria HU-15.4 (hallazgo BLOQUEANTE-01): sin el prefijo, la peticion no
 * encontraba ninguna ruta y Player-Inventory respondia 404 de framework, que
 * este cliente interpretaba indistinguiblemente del 404 de negocio "sin
 * heroe equipado" (ver mas abajo) -- todo JOIN fallaba con
 * `PlayerWithoutEquippedHeroError`, tuviera o no el jugador un heroe real.
 *
 * SOLO EXTRAE `playerId`/`heroId` del cuerpo -- ver
 * `PlayerInventoryEquippedHeroPort.ts` para por que el resto del contrato
 * (`reference`, `subtype`, `name`, `baseStats`, `effectiveStats`, `ready`,
 * `selectedAt`) no se modela en esta version, y por que NO existe `level`
 * (DP-3, confirmado que no existe en el dominio de Player-Inventory).
 */
export class PlayerInventoryHttpClient implements PlayerInventoryEquippedHeroPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async getEquippedHero(playerId: string): Promise<EquippedHero | null> {
    const result = await getInternalJson(
      SERVICE,
      `/api/internal/v1/players/${encodeURIComponent(playerId)}/equipped-hero`,
      this.options,
    )

    // 404: el jugador no tiene ningun heroe equipado todavia. Camino de
    // negocio valido (a diferencia del 404 de Account) -- `JoinBattleRoom`
    // decide que hacer con `null`.
    if (!result.found) {
      return null
    }

    return parseEquippedHero(result.body, playerId)
  }
}

const parseEquippedHero = (body: unknown, expectedPlayerId: string): EquippedHero => {
  if (typeof body !== 'object' || body === null) {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  const { playerId, heroId } = body as Record<string, unknown>

  if (typeof playerId !== 'string' || playerId !== expectedPlayerId) {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  if (typeof heroId !== 'string' || heroId.trim().length === 0) {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  return { playerId, heroId }
}
