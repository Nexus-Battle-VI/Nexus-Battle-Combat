import type {
  BattleHeroCommitmentCommand,
  BattleHeroCommitmentPort,
} from '../../../application/ports/BattleHeroCommitmentPort'
import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
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
 * estable por (sala, jugador), de modo que el reintento del compromiso y la
 * liberacion usan la MISMA clave.
 *
 * QUE PASA CON UN `422`: Player/Inventory rechaza cuando el heroe no es de ese
 * jugador o ya esta en otra batalla. Aqui se traduce a `UpstreamServiceError`
 * porque desde Combat es un fallo de la operacion, no un resultado de negocio del
 * jugador que esta iniciando: la sala no arranca y se dice por que.
 */
export class PlayerInventoryBattleCommitmentHttpClient implements BattleHeroCommitmentPort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async commit(command: BattleHeroCommitmentCommand): Promise<void> {
    const result = await postInternalJson(
      SERVICE,
      commitPath(command.heroId),
      {
        operationId: toBattleCommitmentOperationId(command.roomId, command.playerId),
        playerId: command.playerId,
        reference: command.roomId,
        expiresAt: command.expiresAt.toISOString(),
      },
      this.options,
    )

    if (result.outcome === 'ok') {
      return
    }

    throw new UpstreamServiceError(SERVICE, describe(result))
  }

  async release(roomId: string, playerId: string): Promise<void> {
    const result = await postInternalJson(
      SERVICE,
      releasePath(toBattleCommitmentOperationId(roomId, playerId)),
      {},
      this.options,
    )

    if (result.outcome === 'ok') {
      return
    }

    throw new UpstreamServiceError(SERVICE, describe(result))
  }
}

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
