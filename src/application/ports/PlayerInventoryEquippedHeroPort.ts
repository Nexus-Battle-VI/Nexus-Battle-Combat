/**
 * Heroe equipado resuelto de Player-Inventory (HU-15.2, RF-15, DP-4; HU-25).
 *
 * Espejo LOCAL del contrato `GET /api/internal/v1/players/:playerId/equipped-hero`
 * (`@InternalOnly()`, Nexus-Battle-Player-Inventory): cada servicio mantiene su
 * frontera, asi que estos tipos NO se importan de Player-Inventory ni de un
 * paquete comun. Si el contrato cambia, cambia aqui a mano y el parser lo
 * detecta.
 *
 * Contrato upstream: `{ playerId, heroId, reference, subtype, name, baseStats,
 * effectiveStats, activeEffects, ready, selectedAt }`.
 *
 * QUE SE MODELA Y QUE NO:
 *
 *  - Se modelan `playerId`, `heroId`, `reference`, `subtype`, `baseStats`,
 *    `effectiveStats`, `activeEffects`, `ready` y `selectedAt`.
 *  - `name` NO se modela: ningun caso de uso de Combat lo usa (el nombre visible
 *    del participante sale de Account, no del heroe).
 *  - `level` NO existe: confirmado por Player-Inventory que el dato no existe en
 *    su dominio (DP-3). Combat NO LO INVENTA.
 *  - `maxPower` NO es un campo del contrato: es `effectiveStats.power` (HU-11),
 *    la base de Catalog mas los modificadores permanentes del equipamiento
 *    (HU-28). El parser lo deriva de `effectiveStats.power`, asi que los dos
 *    valen lo mismo POR CONSTRUCCION y no pueden discrepar. Se conserva porque
 *    HU-11 (`createHeroPower(heroId, maxPower)`) ya lo consume.
 *
 * `subtype` viaja como `string` y NO se valida contra el registro de subtipos
 * en el parser: hacerlo rechazaria (503) el INGRESO A SALA de un jugador con un
 * heroe de un subtipo nuevo, cuando el ingreso ni siquiera usa la tabla de
 * efectos. Se valida (`parseHeroSubtype`) cuando de verdad se necesita, al
 * construir la tabla (`BuildHeroEffectTable`).
 */
export interface EquippedHero {
  readonly playerId: string
  readonly heroId: string
  /** Referencia con la que el heroe figura en el inventario del jugador. */
  readonly reference: string
  /** Codigo de subtipo (`hero-subtypes-v1`), tal como lo publica Player-Inventory. */
  readonly subtype: string
  readonly baseStats: EquippedHeroStats
  /**
   * Estadisticas con los modificadores PERMANENTES ya incorporados
   * (`appliedToStats = true`). Un efecto marcado asi NO debe volver a
   * sumarse: ya esta aqui.
   */
  readonly effectiveStats: EquippedHeroStats
  /** Poder maximo del heroe (`effectiveStats.power`). Entero no negativo. */
  readonly maxPower: number
  /**
   * Efectos del equipamiento vigente, tal como HU-28 los conserva. Combat los
   * RECIBE; que hace con cada uno lo decide `BuildHeroEffectTable`, y lo que el
   * requisito no define queda declarado como pendiente, no aplicado.
   */
  readonly activeEffects: readonly EquippedHeroEffect[]
  readonly ready: boolean
  /** Instante ISO-8601 en que el jugador preparo el heroe. */
  readonly selectedAt: string
}

/**
 * Magnitud tal como la publica Player-Inventory (que la recibe de Catalog).
 * No se convierte ni se colapsa: un dado sigue siendo un dado y un porcentaje
 * sigue siendo `basisPoints`, sin interpretar su unidad.
 */
export type EquippedHeroMagnitude =
  | { readonly mode: 'FIXED'; readonly amount: number }
  | { readonly mode: 'PERCENTAGE'; readonly basisPoints: number }
  | { readonly mode: 'DICE'; readonly count: number; readonly sides: number }

export interface EquippedHeroStats {
  readonly power: number
  readonly health: number
  readonly defense: number
  readonly attack: number | null
  readonly damage: EquippedHeroMagnitude | null
  readonly healing: EquippedHeroMagnitude | null
}

/**
 * Efecto de equipamiento normalizado (contrato cerrado de Player-Inventory:
 * sin `raw`, sin ranura y sin la condicion de activacion, solo su indicador).
 *
 * `kind`, `target`, `statistic` y `operation` viajan como TEXTO: el vocabulario
 * lo posee Catalog y puede crecer. Rechazar un valor nuevo en el parser
 * bloquearia el ingreso a sala de cualquier jugador que lo lleve equipado; en
 * cambio se clasifica (`assessEquipmentEffect`) y lo desconocido queda
 * declarado como pendiente, nunca aplicado ni descartado en silencio.
 */
export interface EquippedHeroEffect {
  /** Procedencia, solo para trazabilidad. */
  readonly sourceProductId: string
  readonly sourceProductReference: string
  readonly kind: string
  readonly target: string
  readonly statistic?: string
  readonly operation?: string
  readonly magnitude?: EquippedHeroMagnitude
  /** Ausente = permanente. Presente = temporal. */
  readonly durationTurns?: number
  /** `true`: sujeto a una condicion que aqui NO se evalua. No es permanente. */
  readonly hasActivationCondition: boolean
  /** `true`: ya reflejado en `effectiveStats`; no se aplica otra vez. */
  readonly appliedToStats: boolean
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
