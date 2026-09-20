/**
 * Perfil de batalla resuelto de Account (HU-15.2, RF-15, DP-2).
 *
 * Espejo del contrato `GET /internal/accounts/:subject/battle-profile`
 * (`@InternalOnly()`, rama `feat/hu-15-battle-profile-avatar` de
 * Nexus-Battle-Account): `{ subject, displayName, avatarUrl }`.
 *
 * `avatarUrl` SE RECIBE PERO NO SE PERSISTE en Combat (ver
 * `AccountHttpClient.ts` y `JoinBattleRoom.ts` para la justificacion): la
 * imagen real se sirve desde `GET /accounts/:id/avatar` en Account, publico
 * y protegido por JWT; Combat guardar la URL o el binario duplicaria una
 * fuente de verdad que ya tiene dueno y quedaria desactualizada si la
 * persona cambia su avatar despues de unirse.
 */
export interface BattleProfile {
  readonly subject: string
  readonly displayName: string
  readonly avatarUrl: string | null
}

/**
 * Puerto de salida hacia el contrato interno de Account. La implementacion
 * HTTP concreta vive en `adapters/outbound/http/AccountHttpClient.ts`.
 */
export interface AccountBattleProfilePort {
  /**
   * Resuelve el perfil de batalla de `subject` (siempre `identity.subject`
   * del testimonio verificado, nunca un dato del cuerpo de la peticion).
   *
   * Lanza (nunca devuelve `null`): un `subject` sin perfil en Account, para
   * un testimonio ya verificado por Combat, es una anomalia de integridad
   * entre servicios, no un camino de negocio valido -- ver
   * `UpstreamServiceError` en `application/errors/UpstreamErrors.ts`.
   */
  getBattleProfile(subject: string): Promise<BattleProfile>
}

export const ACCOUNT_BATTLE_PROFILE = Symbol('AccountBattleProfilePort')
