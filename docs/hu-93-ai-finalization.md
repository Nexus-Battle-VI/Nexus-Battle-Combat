# HU-93.3 — Cierre JcE sin recompensas ni drops para la IA

## Objetivo

Una batalla JcE 1v1 (`PVE`, Humano vs IA) sigue siendo normal y autoritativa
en todo lo que no es económico: alguien gana, `BattleRoom` queda `FINISHED`,
el `BattleResult` se persiste, los eventos se publican y la telemetría
registra el `outcome` — ganara quien gane.

Lo único que cambia es que **la IA nunca es una entidad económica**: no
recibe créditos, no recibe experiencia, no recibe objetos, no recibe cofre,
no recibe la recompensa configurada de la sala, no recibe drops, no genera
llamadas a Wallet ni a Player-Inventory. Y el equipamiento nunca se
transfiere entre Humano e IA en ninguna dirección.

**Esto NO reduce la recompensa del jugador humano.** `#559` dice "sin
recompensas ni drops *para la IA*", no "JcE no otorga recompensas al
humano". El humano conserva exactamente el mismo derecho económico que ya le
da `BattleCreditsPolicy`/HU-22, gane o pierda contra la IA.

## Matriz funcional

| | Humano gana | IA gana |
|---|---|---|
| Resultado | `HUMAN = WON`, `AI = LOST` | `AI = WON`, `HUMAN = LOST` |
| `AI.credits` | `null` | `null` |
| `RewardWorkflow` de la IA | ninguno | ninguno |
| Llamada a Wallet por la IA | ninguna | ninguna |
| Llamada a Player-Inventory grant por la IA | ninguna | ninguna |
| Drop IA → Humano | nunca | — |
| Drop Humano → IA | — | nunca |
| Recompensa normal del Humano (HU-22) | preservada | preservada (participación) |
| `outcome`/telemetría | `WIN`, ganador real | `WIN`, ganador real (la IA, sin ocultarlo) |

## Dos brechas reales cerradas (lo único que cambió)

El resto de las reglas de esta matriz ya estaban correctamente
implementadas en `develop` antes de esta Task (ver «Ya estaba correcto» más
abajo). Las dos únicas brechas reales eran puntos donde una partida PVE se
conectaba, sin necesidad, al subsistema de drop de Versus (HU-30) — nunca al
de recompensas (HU-22), que ya era mode-agnostic por diseño y ya ignoraba a
la IA correctamente.

### 1. `StartBattle` capturaba el snapshot de drop sin distinguir modo

`StartBattle.start()` capturaba un snapshot de equipamiento
(`BattleDropInventoryPort.capture`) de cada héroe humano al arrancar **toda**
batalla, PVP o PVE. El único lector de ese snapshot es
`PersistVersusDropDecision`, que ya se limita a PVP — en PVE nadie lo leía
nunca. Capturarlo igual solo añadía una llamada saliente a Player-Inventory
que podía bloquear el arranque de una justa Humano vs IA sin ningún
beneficio.

Corregido: la captura ahora solo ocurre cuando `room.mode === BattleMode.Pvp`.

**Esto NO toca el compromiso HU-29**: el héroe humano de una partida PVE
sigue comprometiéndose (bloqueando su equipamiento) exactamente igual.
`BattleHeroCommitment` (HU-29) y `BattleDropInventory` snapshot (HU-30) son
responsabilidades distintas; solo la segunda se limitó a PVP.

### 2. `IntervalBattleDropScheduler` barría salas PVE sin necesidad

El barrido periódico (cada 2 s) de conciliación de drops recorría **todas**
las salas `IN_BATTLE`/`FINISHED`, sin filtrar por modo. Una sala PVE
`FINISHED` nunca tiene decisiones de drop que conciliar (`battleDropEvents`
siempre vacío), así que `allCredited` quedaba `true` por vacuidad y el
scheduler llamaba igual a `inventory.closeBattle(roomId)` contra
Player-Inventory — una llamada real para una batalla que nunca abrió nada
ahí. Si esa llamada fallaba, se reintentaba cada 2 s durante 24 h, generando
ruido indefinido en los logs para toda partida JcE.

Corregido: `reconcileRoom` ahora retorna de inmediato si
`room.mode !== BattleMode.Pvp`, antes de tocar workflows de drop,
`inventory.closeBattle` o la liberación de compromisos por este camino.

**Esto NO duplica ni sustituye la liberación de compromiso normal**: en PVE,
`BattleFinalizer.afterFinished` ya libera el compromiso del humano al
terminar (y `ReconcileRewardWorkflows` lo reintenta si el proceso muere
antes). El scheduler de drop nunca necesitó hacerlo también.

## Ya estaba correcto (preservado, con prueba de regresión nueva)

- **`BattleCreditsPolicy.creditEntitlements()`**: ya asigna `credits: null`
  a cualquier participante `kind === 'AI'`, sin conocer el modo — es una
  regla sobre el tipo de participante, no sobre PVP/PVE.
- **`CreateRewardWorkflows`**: ya se salta cualquier participante con
  `playerId === null` o `credits === null` — por tanto la IA nunca genera
  `RewardWorkflow`, sin importar quién ganó. El humano sigue recibiendo el
  suyo normalmente (`createIfAbsent`, idempotente por
  `battle:<roomId>:player:<playerId>:credit`). Es mode-agnostic: no lee
  `notification.mode`.
- **`ProcessRewardWorkflow`**: los únicos puntos de llamada a
  `RewardCreditPort.creditBattleReward` y `RewardGrantPort.grant` toman la
  identidad de un `RewardWorkflow` ya persistido — y esos solo existen para
  quien `CreateRewardWorkflows` ya proceso (nunca la IA). No hay ningún otro
  camino que pueda invocar esos puertos con una identidad de IA.
- **`PersistVersusDropDecision`**: `if (previous.mode !== BattleMode.Pvp)
  return next` es lo PRIMERO que ejecuta — antes de `inventory.find(...)` y
  antes de cualquier sorteo. En PVE no consume ningún índice de la secuencia
  HU-24 por este concepto: los únicos sorteos de un turno PVE son los del
  combate (ataque, efecto, daño), exactamente los mismos que en PVP.
- **`BattleDropState` (`hasPendingVersusDrop`/`battleDropEvents`)**: solo
  leen eventos ya persistidos en la sala; sin la rama PVP de
  `PersistVersusDropDecision`, siempre devuelven vacío/`false`.
- **`BattleResultPublisherPort`/`RewardWorkflowResultPublisher`/
  `ReconcileRewardWorkflows`**: la IA aparece en `BattleFinishedNotification.participants`
  (nunca se oculta el resultado) con `playerId: null`, `credits: null`. El
  publish en vivo y la reconciliación tras reinicio pasan por el MISMO
  `CreateRewardWorkflows.execute`, así que ambos caminos quedan cubiertos
  por el mismo filtro.
- **Resultado de combate (`BattleRoom`/`BattleResult`)**: el cálculo de
  `WON`/`LOST`/`NO_WINNER` no distingue `kind` en ningún punto. Si la IA
  gana, el resultado es `WIN` con la IA como ganadora — las reglas
  económicas nunca alteran quién ganó.
- **Experiencia Online**: no existe ninguna integración de
  `ResolveExperienceRolls` (HU-09, de Misiones) alcanzable desde
  `BattleFinalizer` ni desde ningún camino de batalla Online. No se crea
  ninguna aquí: la ausencia ya es la regla correcta.
- **Apuestas (HU-23)**: `StakeNotAllowedInPveError` ya rechaza cualquier
  apuesta en una sala PVE (`BattleRoom.create`/`join`). Fuera de alcance de
  esta Task; no se tocó.
- **`BattleFinalizer`**: conserva sus siete pasos en el mismo orden fijo
  (vencimientos, presencia, lobby, liberación de conexiones, compromiso,
  resultado, telemetría) sin ninguna rama `if (PVE) return` al inicio — las
  responsabilidades no económicas (notificar, liberar conexiones, registrar
  outcome) se aplican igual en PVP y PVE.
- **`BotParticipantFactory`**: el equipamiento de la IA es una definición
  efímera leída de Catalog, nunca inventario real de Player-Inventory; no
  hay ninguna instancia transferible que pudiera salir de ahí.

## Fuera de alcance de esta Task

- **Tournament** (EPIC-09): no se modifica `Nexus-Battle-Tournament`, no se
  implementan reglas de IA de torneo ni premios de bracket.
- **Misiones**: las recompensas/drops de HU-71/HU-72 tienen sus propias
  Historias; esta Task es exclusivamente JcE Online.
- **EN-036 (Neural/MCTS/entrenamiento)**: sin relación con el cierre
  económico de la batalla.
- **Management#560 (E2E final Humano vs IA)**: queda para después; esta
  Task no la implementa.

## Trazabilidad

Management#559 (esta Task), HU padre Management#553, Management#557
(HU-93.1), Management#558 (HU-93.2), ADR-023.
