# HU-22 - Créditos de victoria y cofre de recompensa (orquestación en Combat)

> Estado: **implementado en Combat** (Task [#429](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/429)) sobre el contrato
> [`hu-22-reward-contract-v1`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-22-reward-contract-v1.md)
> (Task [#427](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/427)). Depende de Wallet (Task
> [#428](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/428)) y Player-Inventory (Task
> [#430](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/430)).

## Trazabilidad

| Elemento            | Referencia                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario | [HU-22 #69](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/69) · RF-22 · EPIC-06                                                                 |
| Bloqueada por       | HU-21 (#65), **cerrada**. Consume `BattleFinishedNotification` sin reabrirla                                                                                        |
| Aclaraciones del PO | Management #69, comentarios del 2026-09-22 (timezone `America/Bogota`, reward table, regla post-2/2, cofre de reveal inmediato)                                     |
| Arquitectura        | ADR-019 (Wallet dueño del saldo/progreso; Combat dueño del workflow y del RNG), ADR-021 (`RandomSequencePort`, índice uniforme 1..8000 — reutilizado, no reabierto) |

## Qué implementa esta Task

Combat no acreditaba nada (HU-21 §9: "el derecho... Combat no acredita nada"). HU-22 cierra ese circuito:

1. **`RewardWorkflowResultPublisher`** reemplaza a `LoggingBattleResultPublisher` en la composición (que sigue existiendo, documentada como el adaptador de HU-21, simplemente ya no se conecta). Conserva el mismo registro `battle_finished` y además crea los `RewardWorkflow` de la batalla (uno por participante `HUMAN`) y los procesa de inmediato, sin bloquear la respuesta de combate (`publish()` sigue siendo síncrono, igual que HU-21 lo definió).
2. **`ProcessRewardWorkflow`** avanza un workflow: `PENDING_CREDIT` → Wallet → (`CREDIT_CONFIRMED` sin cofre, o `CHEST_ELIGIBLE` con cofre) → sorteo → `REWARD_SELECTED` → Player-Inventory → `COMPLETED`.
3. **`IntervalRewardWorkflowScheduler`** (mismo patrón que `IntervalBattleDeadlineScheduler`, HU-21) recoge lo que no llegó a un estado terminal, cada segundo, y también al arrancar el proceso.
4. **`GET /v1/combat/rooms/:roomId/reward`** — vía de recuperación para el jugador autenticado, mismo criterio que `GET /v1/combat/rooms/:roomId` para `BattleResult`.

## AwardPolicy

**No se reimplementa.** `BattleCreditsPolicy.creditEntitlements` (HU-21) ya calcula 2/4/1; `CreateRewardWorkflows` solo deriva `victoryCreditsAmount` (igual a `credits` si el participante ganó, `0` en cualquier otro caso) de ese derecho ya publicado.

## Wallet port

`POST /api/internal/v1/wallet/credits/battle-reward` (`WalletHttpClient`), `operationId` determinista `battle:{battleId}:player:{playerId}:credit`. `postInternalJson` es una ampliación de `InternalHttpClient.ts` (antes solo tenía `GET`), mismo esquema HMAC que `InternalServiceGuard` verifica.

## Chest gate

Combat **no** decide si toca cofre: lo decide Wallet (`chestEarned` en la respuesta). Un `chestEarned=true` mueve el workflow a `CHEST_ELIGIBLE`; `false`, a `CREDIT_CONFIRMED` (que completa sin tocar Player-Inventory).

## RNG

**Corregido dos veces durante el diseño** (ver historial de Infrastructure #123), antes de escribir código en este repositorio:

- Auditando `RandomIndex` se confirmó que el índice es **siempre 1..8000 por construcción** — no hay forma de pedir un espacio distinto (se descartó un diseño anterior de dos sorteos sobre 1..10000).
- Auditando `app.module.ts` se confirmó que existe **una única secuencia de proceso** (`BATTLE_RANDOM_SEQUENCE`), sembrada una vez al arrancar (HU-26, `COMBAT_RANDOM_SEED`), que ya comparten la cola de turnos y los golpes. HU-22 **reutiliza esa misma instancia inyectada** — no crea una secuencia propia del workflow.

`RewardTable` (dominio nuevo, `src/domain/reward/RewardTable.ts`) es el mismo patrón de "rangos contiguos" que `EffectControlTable` (HU-25), sobre el mismo espacio de 8000 filas: una única llamada a `nextIndex()` resuelve directamente uno de los 40 productos (300/150/100 filas según el tier, ya al nivel de producto individual — no hay un segundo sorteo "dentro del tier").

## Reward table

`src/infrastructure/config/reward-table.ts` es una copia embebida del artefacto versionado de Infrastructure (`hu-22-reward-table-v1.json`, 40 productos reales auditados del Catalog, `productId`/`sku` reales). `RewardTable.fromRanges` valida por construcción que los tramos cubren `1..8000` sin huecos ni solapes — un error de configuración hace fallar el arranque, no un sorteo con una tabla rota.

## Inventory port

`POST /api/internal/v1/inventory/grants` (`PlayerInventoryGrantHttpClient`) reutiliza **sin cambiar su forma** el contrato ya implementado de HU-59/HU-69: un lote de un único `{productId, quantity: 1}`. `combat` ya está en el `INTERNAL_CALLERS` de Player-Inventory desde HU-15 — no se necesitó ningún cambio de contrato (ver Player-Inventory PR #40).

## Persistir antes de llamar

Cada llamada saliente (Wallet, Inventory) ocurre solo después de persistir la intención correspondiente: `PENDING_CREDIT` se crea antes de llamar a Wallet; el producto sorteado se persiste (`REWARD_SELECTED`) antes de llamar a Player-Inventory. Un reintento tras un fallo nunca vuelve a sortear (usa el `productId` ya persistido) ni duplica el crédito (mismo `operationId` determinista).

## Recovery

`IntervalRewardWorkflowScheduler.onApplicationBootstrap` procesa un barrido inmediato: no hace falta un caso de uso de "recuperación" aparte, porque el barrido ya consulta el estado persistido (`findNonTerminal`) en cada tick, incluido el primero tras un reinicio.

## Failures

Ningún fallo revierte un crédito ya acreditado por Wallet (HU-22 §66). Un fallo transitorio (503, timeout) dobla como reintentable: no cambia de estado, queda para el siguiente barrido. Un rechazo terminal (409 con payload distinto, 422) mueve el workflow a `TERMINAL_FAILURE`: no se reintenta solo.

## Events

`GET /v1/combat/rooms/:roomId/reward` es la vía de recuperación; Web se entera de que algo cambió por `battle-room.updated` (ya existente, HU-21) y reconsulta — no se añade un segundo socket ni un tipo de evento WS nuevo.

## Tests

- **Unit**: `RewardTable` (dominio + tabla real embebida), `CreateRewardWorkflows`, `ProcessRewardWorkflow` (dobles de Wallet/Inventory/RNG: sin cofre, con cofre, 409, 422, 503 transitorio, fallo de Inventory sin revertir el crédito, retry sin re-sortear), `GetRewardStatus`, `IntervalRewardWorkflowScheduler`, `WalletHttpClient`, `PlayerInventoryGrantHttpClient`, `RewardWorkflowResultPublisher`.
- **Integration**: `GET .../reward` con `PERSISTENCE_DRIVER=memory`.
- **DB** (Mongo Testcontainers): `MongoRewardWorkflowRepository` — transiciones atómicas reales, no-op ante estado de origen no coincidente, y una prueba de "reinicio" (segunda instancia del repositorio sobre la misma base recupera el estado exacto).
- **Guardas estáticas de HU-21** actualizadas, no reabiertas: `reward-status.controller.ts` y `tokens.ts` quedan explícitamente excusados de "ningún adaptador de entrada menciona wallet/credit" (es su propósito); `IntervalRewardWorkflowScheduler` se añade a la lista permitida de `setInterval`.

## Fuera de alcance de esta Task

Web (HU-22.5, [#431](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/431)); HU-23 (apuesta), HU-30 (caída de ítems), HU-10 (recompensa de misión); cambios a HU-21/HU-24/HU-25/HU-26.
