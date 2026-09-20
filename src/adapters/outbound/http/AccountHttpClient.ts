import { UpstreamServiceError } from '../../../application/errors/UpstreamErrors'
import type {
  AccountBattleProfilePort,
  BattleProfile,
} from '../../../application/ports/AccountBattleProfilePort'
import { getInternalJson, type InternalHttpClientOptions } from './InternalHttpClient'

const SERVICE = 'account'

/**
 * Cliente del contrato interno de Account (HU-15.2, RF-15, DP-2):
 * `GET /internal/accounts/:subject/battle-profile`, protegido con
 * `@InternalOnly()` + `InternalServiceGuard` HMAC (rama
 * `feat/hu-15-battle-profile-avatar`).
 *
 * `avatarUrl` SE RECIBE (forma parte del contrato) pero Combat NO LA
 * PERSISTE en ningun lado -- decision de arquitectura de esta tarea, ver
 * `AccountBattleProfilePort.ts`.
 */
export class AccountHttpClient implements AccountBattleProfilePort {
  constructor(private readonly options: InternalHttpClientOptions) {}

  async getBattleProfile(subject: string): Promise<BattleProfile> {
    const result = await getInternalJson(
      SERVICE,
      `/internal/accounts/${encodeURIComponent(subject)}/battle-profile`,
      this.options,
    )

    if (!result.found) {
      // Un `subject` ya verificado por el JWT de Combat sin perfil en
      // Account es una anomalia de integridad entre servicios, no un
      // camino de negocio (ver `AccountBattleProfilePort.getBattleProfile`).
      this.options.logger.warn('account_perfil_no_encontrado', { subject })

      throw new UpstreamServiceError(SERVICE, 'perfil_no_encontrado')
    }

    return parseBattleProfile(result.body, subject)
  }
}

const parseBattleProfile = (body: unknown, expectedSubject: string): BattleProfile => {
  if (typeof body !== 'object' || body === null) {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  const { subject, displayName, avatarUrl } = body as Record<string, unknown>

  if (typeof subject !== 'string' || subject !== expectedSubject) {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  if (avatarUrl !== null && typeof avatarUrl !== 'string') {
    throw new UpstreamServiceError(SERVICE, 'respuesta_invalida')
  }

  return { subject, displayName, avatarUrl: avatarUrl ?? null }
}
