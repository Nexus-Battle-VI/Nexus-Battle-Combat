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
 *  - `level` (HU-08, CA-06) SI se modela, OPCIONAL (un Player-Inventory anterior a
 *    CA-06 no lo manda; ausente = nivel 1). `effectiveStats` YA es
 *    `(base x nivel) + equipamiento` para Ataque, Defensa, Vida y Poder, asi que
 *    Combat NO vuelve a multiplicar esas. Lo usa UNICAMENTE para el Dano: es una
 *    magnitud con dados que solo Combat resuelve, y por decision del PO (opcion A)
 *    el nivel multiplica el RESULTADO FINAL de la tirada (`applyLevelToMagnitudeResult`).
 *    `levelStats` viaja upstream pero Combat no lo modela. Combat NO inventa el
 *    nivel: es dato autoritativo de Player-Inventory.
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
 * construir la tabla (`BuildHeroEffectTable`). Por el MISMO motivo,
 * `PrecombatEligibilityPolicy` (HU-16.2) tampoco lo valida contra el
 * registro: compara el texto crudo contra los DOS codigos restringidos
 * (`CHAMAN`, `MEDICO`), sin rechazar un subtipo nuevo que no este en ninguna
 * lista.
 *
 * AMPLIACION ADITIVA (HU-16.1/HU-16.2, Management#401/#402): se incorporan
 * `blockers` y `loadoutVersion`, ya reales en el contrato de Player-Inventory
 * (`docs/equipped-hero-contract.md` alli) pero no consumidos hasta ahora.
 *
 *  - `blockers`: la MISMA lista de motivos de `HeroReadinessPolicy` que ya
 *    explica un `ready=false`. Antes de esta ampliacion Combat sabia QUE el
 *    heroe no estaba listo, pero no POR QUE -- y no podia comunicarlo a quien
 *    pide unirse. Se reenvian tal cual (`PrecombatEligibilityPolicy`, HU-16):
 *    no se crea una segunda taxonomia de motivos de equipamiento.
 *  - `loadoutVersion`: version real de bloqueo optimista de `HeroLoadout`.
 *    Permite capturar, al unirse, una referencia verificable de la
 *    configuracion aprobada (DP-6 de la auditoria HU-16.1) sin copiar el
 *    inventario del jugador.
 */
export interface EquippedHero {
  readonly playerId: string
  readonly heroId: string
  /** Referencia con la que el heroe figura en el inventario del jugador. */
  readonly reference: string
  /** Codigo de subtipo (`hero-subtypes-v1`), tal como lo publica Player-Inventory. */
  readonly subtype: string
  /**
   * Nivel del heroe (HU-08, `1..8`). Ausente si Player-Inventory es anterior a
   * CA-06. `effectiveStats` ya incorpora el nivel en las estadisticas numericas;
   * Combat lo usa UNICAMENTE para multiplicar el resultado final del Dano.
   */
  readonly level?: number
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
  /**
   * Habilidades especiales del heroe (HU-19, Tabla 7), en el orden de Catalog. Combat las
   * RECIBE y las congela al iniciar la batalla; que efecto sabe ejecutar lo decide
   * `evaluateSkill`. OBLIGATORIO, igual que `activeEffects`: no se sustituye por `[]`
   * cuando falta (un heroe sin sus habilidades por un despliegue mal ordenado parecera no
   * tenerlas), asi que Player-Inventory se despliega primero.
   */
  readonly abilities: readonly EquippedHeroAbility[]
  readonly ready: boolean
  /**
   * Motivos por los que `ready` es `false` (HU-16.1/HU-16.2). Vacio cuando
   * `ready` es `true`. Mismos codigos que `HeroReadiness.blockers[].code` de
   * Player-Inventory (`HERO_NOT_ACTIVE`, `EQUIPPED_PRODUCT_NOT_OWNED`,
   * `EQUIPPED_PRODUCT_NOT_ACTIVE`, y los que ese servicio agregue despues):
   * texto abierto, no una union cerrada -- el vocabulario lo posee
   * Player-Inventory.
   */
  readonly blockers: readonly EquippedHeroBlocker[]
  /**
   * Version de bloqueo optimista de `HeroLoadout` (HU-16.1/HU-16.2, DP-6).
   * `0` cuando el heroe nunca tuvo loadout persistido. Entero no negativo.
   */
  readonly loadoutVersion: number
  /** Instante ISO-8601 en que el jugador preparo el heroe. */
  readonly selectedAt: string
  /**
   * AMPLIACION ADITIVA (HU-31, contrato `hu-31-equipped-epic-v1` §5/§8).
   *
   * Epica equipada del heroe, YA RESUELTA por Player-Inventory (misma
   * `applyEpicEffects` de siempre, invocada una vez por peticion, igual
   * patron que `abilities`). Combat la RECIBE y la congela en el snapshot
   * inicial de batalla (`CombatProfile.epic`); no la vuelve a resolver, no
   * la ejecuta como accion de turno (eso sigue bloqueado, ver
   * `docs/hu-19-skills.md`) y no la trata como candidata de drop PvP
   * (HU-30: ese canal es `battle-drops/snapshots`, uno completamente
   * distinto que nunca lee este campo).
   *
   * AUSENTE (no `null`) cuando el heroe no tiene epica equipada -- mismo
   * criterio de ausencia explicita que el resto de este contrato.
   */
  readonly epic?: EquippedHeroEpic
}

/**
 * Epica equipada, ya resuelta (HU-31; correccion HU-19/HU-31 tras
 * GAP-HU31-CATALOG-MULTI-EFFECT). Lista blanca: ningun campo adicional de
 * Catalog cruza esta frontera.
 *
 * `baseEffect`/`specificEffects` son la definicion cruda (para que una vista
 * publica pueda mostrar "que hace" incluso sin coincidencia de subtipo);
 * `applied.*` es el resultado YA resuelto por `applyEpicEffects` con el
 * subtype real del heroe -- `baseApplied` siempre que la definicion lo
 * declare (o `null` si es "No aplica"), `additionalApplied` SOLO si el
 * subtype coincidio (lista: puede traer mas de un efecto simultaneo).
 *
 * `executableEffects` es NUEVO: `applied.baseApplied` (si no `null`) + todos
 * los `applied.additionalApplied`, parseados con el MISMO `parseAbilityEffect`
 * que ya valida los efectos de habilidades -- mismo vocabulario
 * kind/target/statistic/operation/magnitude. Es lo que `UseEpic` ejecuta de
 * verdad; `baseEffect`/`specificEffects`/`applied.*` siguen siendo opacos
 * para presentacion/trazabilidad. `powerCost`/`cooldownTurns` son los mismos
 * valores que Catalog deriva para TODA EPICA (0 y 2).
 */
export interface EquippedHeroEpic {
  readonly epicProductId: string
  readonly epicReference: string
  readonly name: string
  readonly compatibleHeroSubtype: string
  readonly powerCost: number
  readonly cooldownTurns: number
  readonly baseEffect: Readonly<Record<string, unknown>> | null
  readonly specificEffects: readonly Readonly<Record<string, unknown>>[]
  readonly applied: {
    readonly baseApplied: Readonly<Record<string, unknown>> | null
    readonly additionalApplied: readonly Readonly<Record<string, unknown>>[]
  }
  readonly executableEffects: readonly EquippedHeroAbilityEffect[]
}

/** Costo de Poder de una habilidad tal como lo publica Catalog v1 (Tabla 7). */
export type EquippedHeroPowerCost =
  { readonly mode: 'FIXED'; readonly amount: number } | { readonly mode: 'ALL_AVAILABLE' }

/**
 * Efecto de una habilidad normalizado (HU-19): lista blanca de Player-Inventory, sin `raw`,
 * sin la condicion de activacion (solo su indicador) y sin el codigo de una inmunidad.
 * `kind`, `target`, `statistic` y `operation` viajan como TEXTO: el vocabulario es de
 * Catalog y puede crecer; lo desconocido se rechaza al ejecutar, no al ingresar a sala.
 */
export interface EquippedHeroAbilityEffect {
  readonly kind: string
  readonly target: string
  readonly statistic?: string
  readonly operation?: string
  readonly magnitude?: EquippedHeroMagnitude
  readonly durationTurns?: number
  readonly hasActivationCondition: boolean
}

/**
 * Habilidad especial de un heroe (HU-19). `abilityId` es el `productId` de Catalog: el
 * identificador que el cliente envia en `useSkill`. `reference` es solo trazabilidad.
 */
export interface EquippedHeroAbility {
  readonly abilityId: string
  readonly reference: string
  readonly name: string
  readonly powerCost: EquippedHeroPowerCost
  /** Turnos propios de recarga tras usarla (Catalog v1: 1). Entero >= 1. */
  readonly chargeTurns: number
  readonly effects: readonly EquippedHeroAbilityEffect[]
}

/**
 * Motivo de bloqueo de readiness, tal como lo publica `HeroReadinessPolicy`
 * de Player-Inventory. `code` viaja como texto abierto por el mismo motivo
 * que `kind`/`target`/`statistic` de `EquippedHeroEffect`: el vocabulario lo
 * posee Player-Inventory y puede crecer sin que Combat deba reconocerlo para
 * reenviarlo.
 */
export interface EquippedHeroBlocker {
  readonly code: string
  /** Ranura afectada, o `null` cuando el impedimento es del propio heroe. */
  readonly slot: string | null
  readonly reference: string
  readonly detail: string
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
