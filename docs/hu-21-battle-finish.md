# HU-21 - Determinar condicion de finalizacion de la batalla

> Estado: **implementado en Combat** (Task [#418](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/418)) sobre el contrato
> [`hu-21-battle-finish-v1`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-21-battle-finish-v1.md)
> (Task [#417](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/417)). La interfaz de resultado
> ([#419](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/419)) y la validacion integrada
> ([#420](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/420)) son Tasks aparte. Este documento distingue en cada punto
> que es requisito explicito, decision solicitada por el PO, decision elegida y **pendiente de ratificar**, decision tecnica o pendiente.

## Trazabilidad

| Elemento            | Referencia                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario | [HU-21 - Determinar condicion de finalizacion de la batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/65) (#65) - RF-21 - EPIC-06                                                                      |
| Bloqueada por       | HU-17 (#26), HU-18 (#62), HU-19 (#63) y HU-20 (#64), todas cerradas                                                                                                                                                             |
| Consumida por       | HU-22 (#69), HU-23 (#70), HU-30 (#77), HU-29 (#76) y HU-09 (#18): **no se implementan aqui**; esta HU entrega el estado terminal y la notificacion                                                                              |
| Arquitectura        | ADR-019 (Combat unica autoridad), ADR-020 (WebSocket con `commandId`, `seq`, persistir antes de difundir; «cuando una desconexion se convierte en abandono es regla de producto»). No se usa ADR-021: la finalizacion no sortea |
| Fuente oficial      | «Proyecto Integrador II»: §6.1.3 (fin de partida), §7.6 (creditos y vista de alto impacto) y HU-11 (restaurar Poder al terminar)                                                                                                |

## Clasificacion de lo decidido

| #   | Tipo                                                                                     | Contenido                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requisito explicito                                                                      | Tres causas de cierre (eliminacion, desconexion, 6 minutos); turno de 30 s; al vencer el global gana el mayor porcentaje de vida; **un unico resultado** antes de distribuir recompensas; liberacion de recursos; los temporizadores son del servidor                            |
| 2   | Fuente oficial                                                                           | §6.1.3, §7.6 y HU-11 (Poder restaurado en la vista final)                                                                                                                                                                                                                        |
| 3   | Decision arquitectonica `Accepted`                                                       | Combat es la unica autoridad; persistir antes de difundir; una conexion caida queda «desconectada», no «abandonada» (ADR-020)                                                                                                                                                    |
| 4   | **Solicitada por el PO por chat externo (2026-09-21, via Dabji); no consta en el Issue** | (D1) Gracia de **30 s** para reconectar; (D2) si al vencer los 6 min ambos equipos tienen **el mismo porcentaje**, gana el de **mas vida restante absoluta**                                                                                                                     |
| 5   | **Elegida por Dabji (2026-09-21), pendiente de ratificar por el PO**                     | (D3) El turno vencido **pierde el turno**: se cierra sin accion y pasa al siguiente, sin cerrar la batalla; (D4) los **creditos del §7.6** se publican como **derecho** en la notificacion; Combat **no acredita nada** y Web **no los muestra como concedidos**                 |
| 6   | Decision tecnica (a confirmar)                                                           | (D5) Ganador por desconexion = equipo rival; (D6) porcentaje = suma de vida / suma de vida maxima, comparacion **entera** por producto cruzado; (D7) un heroe eliminado no juega turno; (D8) chat de sala cerrado en `FINISHED`; (D9) constantes fijas, sin variables de entorno |
| 7   | Pendiente                                                                                | Empate total (mismo porcentaje y misma vida absoluta): `NO_WINNER`, sin desempate inventado. Transporte de la senal hacia HU-29 y de las recompensas hacia HU-22/23/30                                                                                                           |

## Flujo

```text
Accion letal (attack/useSkill)                        Barrido de vencimientos (cada 1 s) o comando que llega tarde
  BattleRoom.applyBasicAttack/applySkill                ProcessBattleDeadlines (cerrojo por sala)
    UNA escritura: Vida + evento de la accion             BattleDeadlineSettler.settle
    + battleFinished (seq contiguo) + result             BattleRoom.settleDeadlines (PURO)
    + Poder restaurado (HU-11) + FINISHED                  el mas antiguo: gracia > global > turno
  Gateway.publish [accion, battleFinished]               UNA escritura: turnTimedOut | battleFinished
  BattleFinalizer.afterFinished (orden fijo)             publica DESPUES de persistir
    1 book.cancel  2 presence.clear  3 notifyRoomUpdated(FINISHED)
    4 release(conexiones, sin cerrar sockets)  5 publish(notificacion a consumidores)
```

## Temporizadores (autoridad del servidor)

| Temporizador          | Duracion     | Origen                                                      | Vence cuando                              |
| --------------------- | ------------ | ----------------------------------------------------------- | ----------------------------------------- |
| Global                | `360 000 ms` | `battle.startedAt`                                          | `ahora >= startedAt + 360 000`            |
| Turno                 | `30 000 ms`  | `battle.turnStartedAt`                                      | `ahora >= turnStartedAt + 30 000`         |
| Gracia de desconexion | `30 000 ms`  | instante en que se pierde la **ultima** conexion de batalla | `ahora >= desde + 30 000` y sigue ausente |

- **El limite es inclusivo** (contrato §3): `deadline - 1 ms` no vence; `deadline` si.
- Las constantes viven en `BattleTimingPolicy`; **no hay variables de entorno** que las cambien (una guarda estatica lo comprueba).
- Todo el tiempo sale de `ClockPort`. El dominio no lee el reloj.
- **Dos mecanismos, ambos obligatorios:** el barrido de 1 s (`IntervalBattleDeadlineScheduler`, `tick()` publico) y la **liquidacion perezosa**: `attack`/`useSkill` liquidan los vencimientos de su sala ANTES de validar. Un comando que llega despues del vencimiento nunca se ejecuta sobre un turno o batalla vencidos: recibe `NOT_YOUR_TURN` o `BATTLE_NOT_ACTIVE`.
- **Los vencimientos sobreviven al reinicio** (son derivables del estado): `RecoverBattleDeadlines` carga las salas `IN_BATTLE` al arrancar y registra su proximo vencimiento. La **presencia no se persiste**: al arrancar, todo participante humano empieza su gracia en ese instante.
- `tick()` adelanta el vencimiento un periodo antes de procesar y no reentra una sala en vuelo; un fallo en una sala se registra y no detiene a las demas. Con `BATTLE_DEADLINE_SCHEDULER_OPTIONS = { autoStart: false }` no hay ningun temporizador real (pruebas deterministas).

## Presencia y gracia (D1)

- **Conexion de batalla**: conexion autenticada que completo `resume` de esa sala y cuyo `sub` es un participante humano. `subscribe` (lobby) **no** cuenta. Varias pestanas del mismo jugador cuentan como una: la gracia empieza al caer la **ultima**.
- Al perder la ultima conexion: `presence.markAbsent` (conserva el `desconectadoDesde` mas antiguo) y `book.ensureDueBy(graceDeadline(ahora))`. Al volver a hacer `resume` dentro de la gracia, `markPresent` la cancela.
- **Semilla de presencia:** al iniciar la batalla, quien no tiene conexion de batalla en ese instante empieza su gracia en `startedAt` (lo consulta `StartBattle` por `BattleConnectionsPort`, que implementa el gateway).
- Una conexion que sobrevive al final **no se cierra** y deja de ser conexion de batalla (`release`).
- Limitacion conocida y aceptada: el latido de 25 s puede tardar hasta ~50 s en cerrar una conexion muerta; la desconexion efectiva es «cierre detectado + 30 s».

## Condiciones de cierre y matriz

| Condicion                                       | `reason`                       | `outcome`   | Ganador                     | Cierra      |
| ----------------------------------------------- | ------------------------------ | ----------- | --------------------------- | ----------- |
| Todos los heroes de un equipo con Vida 0        | `ELIMINATION`                  | `WIN`       | Equipo del actor            | Si          |
| Gracia vencida y sigue ausente                  | `DISCONNECTION`                | `WIN`       | Rival del desconectado (D5) | Si          |
| 6 min con porcentajes distintos                 | `TIME_LIMIT` (`LIFE_PERCENT`)  | `WIN`       | Mayor porcentaje            | Si          |
| 6 min, mismo porcentaje, vida absoluta distinta | `TIME_LIMIT` (`ABSOLUTE_LIFE`) | `WIN`       | Mayor vida absoluta (D2)    | Si          |
| 6 min, mismo porcentaje y misma vida            | `TIME_LIMIT` (`null`)          | `NO_WINNER` | -                           | Si          |
| 6 min en batalla sin datos de Vida              | `TIME_LIMIT` (`null`)          | `NO_WINNER` | -                           | Si          |
| 30 s del turno                                  | - (`turnTimedOut`)             | -           | -                           | **No** (D3) |

- La **eliminacion se evalua en la misma escritura** de la accion: el evento de la accion y `battleFinished` van juntos, con `seq` consecutivos. En 1 contra 1 la primera eliminacion finaliza; en 2 contra 2 eliminar a uno **no** finaliza y su turno se salta (D7: `turnsCompleted` suma la posicion saltada, sin evento).
- **Un equipo solo puede ser eliminado si TODOS sus combatientes tienen Vida**: un participante sin perfil (`AI`) impide la eliminacion de su equipo.
- **Un mismo evento con varios vencimientos** procesa el mas antiguo; empate exacto: `DISCONNECTION` > `TIME_LIMIT` > turno. Entre varias gracias, el `desconectadoDesde` mas antiguo (y la posicion menor de la cola como desempate).
- `NO_WINNER` es el residuo del empate total: **pendiente del PO**; no se inventa desempate.
- `lifePercent` del resultado es **solo para mostrar** (dos decimales); la decision usa el producto cruzado entero (D6).

## Resultado (`BattleResult`)

Se persiste con la sala y viaja identico en `battleFinished` y en el `snapshot` (contrato §5): `reason`, `outcome`, `winnerTeamLabel`, `finishedAt`, `tiebreak`, `disconnected`, `teams` (siempre los dos, en el orden de la sala) y `participants` (en el orden de la cola, con `WON`/`LOST`/`NO_WINNER`). **No lleva creditos ni recompensas** y **no lleva el Poder**: la vista final lo trae restaurado (HU-11). `parseBattleResult` valida la forma completa al restaurar y ante cualquier incoherencia lanza `DomainError`.

## Eventos y mensajes (contrato §6)

- `turnTimedOut`: `{ completedPosition, timedOut: {teamLabel, seat}, battle }`; la vista ya trae el turno avanzado y `deadlines` nuevos. No consume comandos (`handledCommands` no cambia).
- `battleFinished`: `{ result, battle }`; la vista es la FINAL, **sin `deadlines`** y con el Poder restaurado. Tras el, no hay mas eventos en la sala.
- Aditivos de HU-21: `BattleView.deadlines` (ISO; presente en curso, ausente al final), `resume.ok.serverTime`, `snapshot.result` y `GET /rooms/{id}.result`. Un Web anterior ignora estos campos.
- Las acciones despues del final responden `BATTLE_NOT_ACTIVE` (codigo existente), **sin sorteos y sin cambios**. `start` sobre `FINISHED` responde el conflicto de estado ya existente; `join`, `leave` y `cancel` responden los errores de estado ya existentes.

## Liberacion de recursos (contrato §8)

Al persistir `FINISHED` y solo entonces, `BattleFinalizer.afterFinished` ejecuta **en orden fijo** y **nunca lanza** (cada paso en su `try/catch`): cancela vencimientos, olvida la presencia, notifica al lobby (`battle-room.updated` con `status: FINISHED`), libera las conexiones de batalla **sin cerrar sockets** (pueden seguir leyendo el resultado y hacer `resume`) y publica la notificacion a consumidores. El orden **persistir -> difundir -> liberar** es lo que garantiza que ambos clientes reciban `battleFinished`.

## Notificacion a consumidores (contrato §9)

`BattleResultPublisherPort.publish(notification)` se invoca **una vez** tras persistir y difundir (semantica _al menos una vez_, clave de idempotencia `roomId`). En esta HU el adaptador **solo escribe el registro `battle_finished`** con `roomId`, `reason`, `outcome` y `winnerTeamLabel` (sin nombres ni creditos por jugador). Los **creditos del §7.6** viajan como **derecho** (D4): ganador 2 en 1 contra 1 o 4 en equipos; los demas 1; `NO_WINNER` 1 por participante; `AI` `null`. **Combat no acredita nada** y Web no los muestra como concedidos; la entrega es de HU-22/23/30/09.

## Migracion `009` y efecto al desplegar

Migracion **aditiva y autocontenida** (`009-battle-rooms-finish`, con `down`): `status` admite `FINISHED`; `result` opcional; `battle.turnStartedAt` opcional; tipos de evento `turnTimedOut` y `battleFinished`. Ningun documento necesita _backfill_: una sala anterior se restaura con `result: null` y su turno empezado en `startedAt`.

**Aviso de despliegue:** una batalla `IN_BATTLE` anterior a HU-21 que ya supero los 6 minutos **se cierra sola** en el primer barrido (`TIME_LIMIT`, o `NO_WINNER` si no tiene Vida). Es el efecto deseado (libera recursos), pero cambia su estado. Orden: `npm run migrate` (009) **antes** de arrancar esta version.

## Pruebas

| Escenario (contrato §13) | Donde se prueba                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| S-01 a S-03              | `battle-room-finish.domain.spec.ts`, `battle-finish-use-cases.spec.ts`, E2E `battle-finish.e2e.spec.ts`              |
| S-04 a S-09              | `battle-room-finish.domain.spec.ts`, `battle-room-realtime.gateway.spec.ts`, `recover-battle-deadlines.spec.ts`, E2E |
| S-10 a S-14              | `battle-outcome-policy.spec.ts`, E2E                                                                                 |
| S-15 a S-17              | `battle-room-finish.domain.spec.ts`, `process-battle-deadlines.spec.ts`, E2E                                         |
| S-18, S-19               | `battle-deadline-settler.spec.ts`, `battle-finalizer.spec.ts`, `process-battle-deadlines.spec.ts`, E2E               |
| S-20                     | `battle-finish-use-cases.spec.ts`, E2E                                                                               |
| S-21 a S-26              | E2E `battle-finish.e2e.spec.ts` (dos clientes `ws` reales y MongoDB real)                                            |
| Guardas estaticas        | `hu-21-finish-guards.spec.ts`                                                                                        |

Puertas ejecutadas: `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `test:coverage`, `test:db`, `build` y `git diff --check`.

## Pendientes del PO

- Empate total (mismo porcentaje y misma vida absoluta): hoy `NO_WINNER`.
- Ratificar: ganador por desconexion = rival (D5); creditos como derecho sin acreditar, incluidos los del empate y del desconectado (D4); turno vencido = turno perdido (D3); chat de sala cerrado al finalizar (D8).
- Transporte real de la notificacion hacia HU-29 (liberacion del equipamiento) y hacia HU-22/23/30/09.

## Limites y que NO se verifico

- **No hay comunicacion entre servicios**: el puerto de resultados solo escribe un registro.
- **Una sola replica** (ADR-020): presencia, cerrojo y planificador viven en memoria del proceso.
- **No se verifico** con navegadores reales ni contra el sistema desplegado: eso es la Task #420 (protocolo con dos clientes `ws` y MongoDB reales) y la aceptacion manual con dos navegadores. La eleccion de factor (TOTP/correo) y los creditos siguen siendo decision del PO.

## Compatibilidad y despliegue

Aditivo: los mensajes de HU-13/17/18/19 no cambian de forma y un Web anterior ignora los campos nuevos (salvo que una sala `FINISHED` llegue a un Web sin esta version: vera un estado que no conoce; Web #419 lo cubre). Orden: Infrastructure (contrato) -> **Combat** (`npm run migrate`, 009) -> **Web**. Player-Inventory no cambia.
