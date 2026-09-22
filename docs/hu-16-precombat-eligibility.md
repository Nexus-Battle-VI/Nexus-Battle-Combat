# HU-16 — Elegibilidad precombate del héroe antes del combate

Trazabilidad: `RF-16` → Management `#25` (HU-16) → auditoría `#401` (HU-16.1) → esta TASK
`#402` (HU-16.2).

Este documento describe qué implementa HU-16.2 sobre el join de sala existente (HU-15), qué
autoridad tiene cada servicio, y — sobre todo — qué queda **deliberadamente sin implementar**
porque ningún servicio del sistema confirma hoy una fuente autoritativa real. La auditoría
HU-16.1 dejó siete puntos de decisión (DP-1..DP-7); este documento retoma esa numeración.

## DP-1 — Autoridad del equipamiento

Sin cambios respecto a la auditoría: Player-Inventory sigue siendo la única autoridad sobre
selección de héroe, ownership, capacidades 2/6/2, compatibilidad de ranura, lifecycle de
producto y estadísticas efectivas. Combat **no reevalúa nada de esto**: consume el resultado ya
calculado (`ready`/`blockers` de `HeroReadinessPolicy`) y lo reenvía tal cual cuando corresponde
bloquear un `join`.

Lo único que cambió es que Combat **ahora sí lee** dos campos que el contrato interno de
Player-Inventory ya calculaba pero que Combat descartaba: `blockers` (el motivo detrás de
`ready=false`) y `loadoutVersion` (la versión de bloqueo optimista del loadout). Ver
`PlayerInventoryEquippedHeroPort.ts` y `PlayerInventoryHttpClient.ts`.

## DP-2 — Nivel del héroe: sigue siendo GAP

**No implementado.** Se reauditó `develop` de Player-Inventory (commits posteriores a HU-16.1,
incluyendo `HeroPowerPolicy`/`EquippedHeroDto`/`GetEquippedHeroForCombat` de HU-11) y el propio
código de Player-Inventory sigue confirmando, explícitamente, que **no existe** un campo
`level`/`heroLevel`/`experienceLevel` en su dominio. `HeroPowerPolicy` introduce el concepto de
**Poder** (`power`/`maxPower`, HU-11) — un recurso consumible durante el combate, no una
progresión de experiencia — y no debe confundirse con "nivel de héroe" a efectos de RF-16.

Combat no inventa `level = 1` ni ningún valor de reemplazo. `PrecombatEligibilityPolicy` no
tiene ningún parámetro relacionado con nivel: si algún día se agrega, debe ser una decisión de
producto explícita, no una ampliación silenciosa de esta política.

## DP-3 — Nivel mínimo de sala: sigue siendo GAP

**No implementado**, por la misma razón que DP-2: no hay una fuente real de "nivel del héroe"
contra la que comparar un `minLevel` de sala. `BattleRoomSnapshot`/`CreateBattleRoomInput` no
tienen ningún campo de nivel mínimo, y esta TASK no lo agrega.

**Punto de extensión previsto** (si DP-2 se resuelve en el futuro): `BattleRoom` es el
propietario natural de `minLevel` (ya es dueño de `mode`, `teams`, `reward`); se validaría en
`PrecombatEligibilityPolicy`, con un nuevo código de rechazo reservado (`HERO_LEVEL_TOO_LOW`,
ver DP-7) y datos de entrada adicionales (`heroLevel`, `roomMinLevel`) explícitos en la firma de
`assessPrecombatEligibility` — nunca inferidos ni derivados de un valor inventado.

## DP-4 — Misión activa: sigue siendo GAP

**No implementado.** Se reauditó Nexus-Battle-Missions: sigue siendo andamiaje puro (`schema.ts`
declara `interface Database {}` vacía, sin controladores de dominio, `INTERNAL_CALLERS` vacío).
El diseño documentado (`docs/architecture.md` de Missions) prevé que Missions registre un
"compromiso" de tipo `MISSION` en Player-Inventory, pero ese concepto tampoco existe en
Player-Inventory. Ningún servicio expone hoy una consulta real de "¿está este héroe ocupado?".

Combat **no consulta ningún servicio de misiones** y no asume `missionActive = false`.
`PrecombatEligibilityPolicy` no tiene ningún parámetro relacionado con misiones.

**Punto de extensión previsto**: cuando exista una fuente autoritativa real (Missions o
Player-Inventory), se añadiría un puerto de salida nuevo (`ActiveMissionPort`, mismo patrón
puerto + cliente HTTP HMAC que `PlayerInventoryEquippedHeroPort`), consultado desde
`JoinBattleRoom` antes de `assessPrecombatEligibility`, con su propio código de rechazo
reservado (`HERO_ON_ACTIVE_MISSION`, DP-7) y su propio `UpstreamServiceError` si el servicio no
responde — nunca interpretando la ausencia de respuesta como "sin misión activa".

## DP-5 — Chamán/Médico y formato: implementado

Identificadores canónicos reconfirmados: `CHAMAN` y `MEDICO` (sin variantes en inglés),
`HeroSubtype.ts`. La sala **no tiene** un campo `format` de primera clase: "1 contra 1" se
deriva de que ambos equipos tengan `capacity === 1` (`isIndividualFormat`,
`PrecombatEligibilityPolicy.ts`), igual que ya se deriva `totalCapacity()` de la suma de
capacidades.

La regla vive en **Combat** (`PrecombatEligibilityPolicy.assessPrecombatEligibility`), no en
Player-Inventory ni en Web: Combat es quien conoce la sala concreta. `subtype` viaja como texto
crudo (no se valida contra el registro completo de `HeroSubtype`) para no bloquear el ingreso a
sala de un heroe con un subtipo nuevo que aún no está en la tabla de efectos — el mismo criterio
que ya aplicaba `PlayerInventoryHttpClient` antes de esta TASK.

## DP-6 — Snapshot / TOCTOU: capturado, no revalidado

Riesgo: un jugador valida su héroe al unirse, cambia su equipamiento en Player-Inventory, y
Combat sigue usando la configuración anterior sin saberlo.

**Lo que HU-16.2 implementa**: `Participant.heroLoadoutVersion` captura
`EquippedHero.loadoutVersion` (la versión de bloqueo optimista real de `HeroLoadout`) en el
momento exacto de `BattleRoom.join()`. Es una referencia verificable, no una copia del
inventario — mismo criterio que `heroId`/`displayName`. Persistido vía migración aditiva `004`
(Mongo) y expuesto en `battle-room-mapping.ts`.

**Lo que HU-16.2 NO implementa**: la revalidación. Hoy el dominio no modela ninguna transición
de "inicio de combate" más allá de `WAITING_FOR_PLAYERS -> PREPARING` (automática por cupo, sin
validación adicional). No existe un punto real donde comparar `heroLoadoutVersion` capturado
contra la versión vigente en Player-Inventory. Inventar esa transición está fuera del alcance de
esta TASK (HU-16.2 es validación, no motor de combate). Cuando HU-17+ defina el inicio real de
una batalla, ese es el punto donde debe revalidarse: si la versión capturada ya no coincide con
`HeroLoadout.version` actual, la configuración cambió y debe re-ejecutarse
`assessPrecombatEligibility` (o rechazarse directamente) antes de continuar.

`heroLoadoutVersion` **no se expone** en `BattleRoomDto` (lo que ve Web): es un detalle interno
de bookkeeping, no información que HU-16.3 necesite mostrar. Si HU-16.3 lo necesitara, es una
decisión de contrato explícita para esa TASK, no una filtración accidental de esta.

## DP-7 — Errores estructurados: implementado, con reservas explícitas

Antes de esta TASK, `PlayerWithoutEquippedHeroError` caía en el 422 genérico sin ningún `code`
(hallazgo de la auditoría HU-16.1). Ahora tiene `code: 'HERO_NOT_SELECTED'`, siguiendo el mismo
patrón que `AccountProfileMissingError` (`code: 'ACCOUNT_PROFILE_NOT_FOUND'`).

Nuevo: `PrecombatEligibilityBlockedError` (422), con `blockers: PrecombatEligibilityBlocker[]`
completo en el cuerpo — sin colapsar a un único `code` de nivel superior, porque pueden concurrir
varios motivos (p. ej. no listo Y clase no permitida). Mismo patrón que
`HeroReadiness.blockers[].code` de Player-Inventory.

Códigos realmente producibles hoy (reenviados de Player-Inventory o generados por Combat):

- Los que Player-Inventory declare en `HeroReadinessPolicy` (`HERO_NOT_ACTIVE`,
  `EQUIPPED_PRODUCT_NOT_OWNED`, `EQUIPPED_PRODUCT_NOT_ACTIVE`, y los que agregue después) —
  reenviados tal cual, vocabulario abierto.
- `HERO_NOT_READY` (`PrecombatEligibilityPolicy`): defensa en profundidad si Player-Inventory
  alguna vez responde `ready=false` sin ningún `blockers` declarado.
- `HERO_CLASS_NOT_ALLOWED_FOR_FORMAT` (`PrecombatEligibilityPolicy`, DP-5).
- `HERO_NOT_SELECTED` (`PlayerWithoutEquippedHeroError`).

Códigos **reservados pero NO producibles todavía** (documentados aquí para que HU-16.3+ los
reconozca si algún día aparecen, no para que Web los espere ahora):

- `HERO_LEVEL_TOO_LOW` — bloqueado por DP-2/DP-3. Ningún camino de código produce este valor.
- `HERO_ON_ACTIVE_MISSION` — bloqueado por DP-4. Ningún camino de código produce este valor.

Ninguno de los dos aparece como literal en ningún archivo de `src/`: no existen como constantes
todavía, precisamente para que no se pueda importar y usar uno "por si acaso" antes de que la
fuente autoritativa correspondiente exista.

## Qué NO hace esta TASK (fuera de alcance)

- HU-16.3 (integración Web): Web no cambia. `blockers[]`/`code` ya están en el cuerpo HTTP,
  listos para que HU-16.3 los consuma cuando corresponda.
- Eliminar "Mi Héroe" o consolidarlo con "Mi Inventario" (auditoría HU-16.1, sección 12): no
  tocado.
- Motor de combate, turnos, daño, recompensas: no existen todavía en ningún repositorio.
- Nivel de héroe, nivel mínimo de sala, misión activa: GAPs de producto declarados arriba, no
  resueltos por esta TASK.

## Pruebas

- `test/unit/precombat-eligibility-policy.spec.ts`: la política pura (positivos, negativos,
  frontera de formato, y una prueba que fija la superficie exacta de parámetros para que agregar
  nivel/misión sea una decisión consciente, no un descuido).
- `test/unit/player-inventory-equipped-hero-contract.spec.ts`: parseo estricto de `blockers` y
  `loadoutVersion` en el contrato HTTP hacia Player-Inventory.
- `test/unit/battle-room-use-cases.spec.ts` (`describe('elegibilidad precombate ...')`):
  orquestación completa en `JoinBattleRoom`, incluida la ausencia de persistencia parcial.
- `test/unit/battle-room.domain.spec.ts`: captura de `heroLoadoutVersion` en `BattleRoom.join()`,
  retrocompatibilidad de firma, y rechazo de una versión negativa/decimal.
- `test/unit/battle-room-mapping.spec.ts`: retrocompatibilidad de `heroLoadoutVersion` ausente
  (documentos pre-004) y su ida y vuelta cuando está presente.
- `test/integration/battle-room-http.spec.ts` (`describe('elegibilidad precombate ...')`):
  contrato HTTP completo, incluido que `heroLoadoutVersion` no se filtra al DTO público.
- `test/db/mongo-battle-room-repository.spec.ts`: el validador `$jsonSchema` real de Mongo
  acepta `heroLoadoutVersion` tras la migración `004` y rechaza un valor negativo.
