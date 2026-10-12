import type {
  BattleHeroCommitmentCommand,
  BattleHeroCommitmentPort,
} from '../../../application/ports/BattleHeroCommitmentPort'
import {
  HeroInAnotherBattleError,
  UpstreamServiceError,
} from '../../../application/errors/UpstreamErrors'
import { postInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'
import { toBattleCommitmentOperationId } from './battle-commitment-operation-id'

const SERVICE = 'player-inventory'

const commitPath = (heroId: string): string =>
  `/api/internal/v1/inventory/heroes/${encodeURIComponent(heroId)}/battle-commitments`

const releasePath = (operationId: string): string =>
  `/api/internal/v1/inventory/battle-commitments/${encodeURIComponent(operationId)}/release`

/**
 * Cliente del compromiso de batalla (HU-29, `hu-29-battle-commitment-v1` §3).
 *
 * `combat` ya esta en la lista interna de Player-Inventory desde HU-15, y la ruta
 * se acota con `@InternalCallers('combat')`: no se amplia ningun permiso.
 *
 * EL `operationId` QUE VIAJA ES UN UUID v5, no el id logico: el contrato exige
 * UUID (`@IsUUID()` en el DTO), igual que en las entregas de HU-22. La clave es
 * estable por (sala, jugador, intento de inicio): ver `toBattleCommitmentOperationId`.
 *
 * QUE PASA CON UN `422`: si el heroe sigue en otra batalla (`HERO_COMMITTED`) se lanza
 * `HeroInAnotherBattleError` (EN-031), que Web explica al jugador. Cualquier otro
 * rechazo (p. ej. heroe ajeno) se traduce a `UpstreamServiceError`: desde Combat es
 * un fallo de la operacion y la sala no arranca.
 */
export class PlayerInventoryBattleCommitmentHttpClient implements BattleHeroCommitmentPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async commit(command: BattleHeroCommitmentCommand): Promise<void> {
    const result = await postInternalJson(
      SERVICE,
      commitPath(command.heroId),
      {
        operationId: toBattleCommitmentOperationId(
          command.roomId,
          command.playerId,
          command.attemptStartedAt,
        ),
        playerId: command.playerId,
        reference: command.roomId,
        expiresAt: command.expiresAt.toISOString(),
      },
      this.options,
    )

    if (result.outcome === 'ok') {
      return
    }

    // EN-031: el heroe sigue en otra batalla. Es un motivo de negocio con nombre, no una
    // caida de Player-Inventory: se distingue para que el jugador sepa que hacer.
    if (result.outcome === 'rejected' && codeOf(result.body) === 'HERO_COMMITTED') {
      throw new HeroInAnotherBattleError(command.playerId)
    }

    throw new UpstreamServiceError(SERVICE, describe(result))
  }

  async release(roomId: string, playerId: string, attemptStartedAt: Date | null): Promise<void> {
    const operationIds = [
      ...(attemptStartedAt === null
        ? []
        : [toBattleCommitmentOperationId(roomId, playerId, attemptStartedAt)]),
      // Clave heredada: solo la llevan las batallas que ya corrian al desplegar EN-031.
      toBattleCommitmentOperationId(roomId, playerId),
    ]

    for (const operationId of operationIds) {
      const result = await postInternalJson(SERVICE, releasePath(operationId), {}, this.options)

      if (result.outcome !== 'ok') {
        throw new UpstreamServiceError(SERVICE, describe(result))
      }
    }
  }
}

const codeOf = (body: unknown): string | null =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as { readonly code?: unknown }).code === 'string'
    ? (body as { readonly code: string }).code
    : null

const describe = (
  result: Exclude<Awaited<ReturnType<typeof postInternalJson>>, { outcome: 'ok' }>,
): string => {
  if (result.outcome === 'conflict') {
    return 'operation_id_reutilizado'
  }

  if (result.outcome === 'rejected') {
    return 'heroe_no_disponible'
  }

  return `peticion_invalida_${String(result.status)}`
}
