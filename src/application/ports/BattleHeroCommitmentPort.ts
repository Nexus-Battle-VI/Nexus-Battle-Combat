/**
 * Compromiso de batalla del heroe (HU-29, contrato
 * `hu-29-battle-commitment-v1` de Infrastructure).
 *
 * Combat es el dueño del ciclo de vida de la batalla y por eso es quien
 * COMPROMETE al heroe al iniciarla y lo LIBERA al terminarla. Player/Inventory
 * guarda la marca de ocupacion y bloquea el loadout mientras este vigente.
 *
 * Es el transporte que `ADR-019` ya habia decidido --su tabla de integracion
 * dice «Combat -> Player/Inventory | compromiso del heroe al iniciar; liberar al
 * terminar | Sincrono | operationId»-- y que hasta HU-29 no existia.
 */
export interface BattleHeroCommitmentCommand {
  readonly roomId: string
  readonly playerId: string
  /** `productId` canonico del heroe que entra a la batalla. */
  readonly heroId: string
  /** Hasta cuando vale el compromiso. Es lo que impide un bloqueo permanente. */
  readonly expiresAt: Date
}

export interface BattleHeroCommitmentPort {
  /**
   * Compromete el heroe. Lanza `UpstreamServiceError` si Player/Inventory no
   * confirma: el llamador decide, y `StartBattle` decide NO arrancar la batalla,
   * porque arrancarla sin bloqueo dejaria el loadout modificable en combate.
   */
  commit(command: BattleHeroCommitmentCommand): Promise<void>
  /**
   * Lo libera. IDEMPOTENTE por contrato: Player/Inventory responde `204` tanto si
   * lo libero como si ya no estaba, asi que un reintento no es un error.
   */
  release(roomId: string, playerId: string): Promise<void>
}

export const BATTLE_HERO_COMMITMENTS = Symbol('BattleHeroCommitments')
