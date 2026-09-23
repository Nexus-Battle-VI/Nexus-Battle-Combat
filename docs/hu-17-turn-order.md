# HU-17 — Orden de turnos, inicio de batalla y tiempo real

> Estado: **implementado en Combat** el inicio de batalla desde una sala `PREPARING`, la cola de turnos
> inmutable, el avance de turno del lado del servidor, `battleStarted`/`turnAdvanced` con `seq`, el ticket de un
> solo uso, `resume`/`snapshot` y el latido, según [ADR-020](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-020-realtime-combat.md).
> **No implementa** ataque, daño, habilidades, Poder, fin de batalla ni abandono (HU-18, HU-19, HU-21).
> _Actualización:_ el ataque básico ya existe en [HU-18](hu-18-basic-attack.md) y usa el avance de turno de este
> documento; `BattleView` ganó de forma **aditiva** `combatants[]` (Vida) y `battle.combatants` se guarda con la
> migración `007`. Nada de lo descrito aquí cambió de significado._
> Contrato: [hu-17-battle-turn-order-v1.md](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-17-battle-turn-order-v1.md).

## Trazabilidad

| Elemento             | Referencia                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Historia / requisito | [HU-17 #26](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/26) · RF-17 · EPIC-06                    |
| Task de Combat       | [HU-17.2 #406](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/406)                                  |
| Bloqueada por        | HU-14 (crear sala), HU-15 (unirse), HU-16 (elegibilidad precombate), HU-24 (motor pseudoaleatorio) — las cuatro `Done` |

## Flujo

```text
sala PREPARING (cupo completo)
  ↓ POST /api/v1/combat/rooms/:roomId/start   (solo el propietario de la sala; sin cuerpo)
  ↓ revalida a cada HUMAN con Player-Inventory (HU-16): heroe equipado, elegibilidad y version de loadout
  ↓ genera la cola con HU-24 (BoundedRandom: muestreo por rechazo)
  ↓ BattleRoom.startBattle()  →  IN_BATTLE + battleStarted (seq 1)
  ↓ save con bloqueo optimista   ← persiste ANTES de difundir
  ↓ WebSocket: battleStarted a los participantes que hicieron `resume`
  ↓ (servidor) CompleteBattleTurn → turnAdvanced (seq n)
```

**Quién decide.** El cliente _solicita_ el inicio; **Combat es la única autoridad** que lo autoriza, revalida a los
participantes, sortea, persiste y publica. El cliente no elige quién inicia, ni el orden, ni los participantes (la
petición no tiene cuerpo). Se adopta un `POST …/start` explícito e idempotente en lugar de iniciar dentro de `join`,
que obligaría a repetir la revalidación de cada participante (llamadas a Player-Inventory) dentro de una unión.

**Quién puede pedirlo (2026-09-22, ampliación).** Solo `requesterId === room.createdBy` puede iniciar la sala; un
participante que no sea el propietario recibe `403` (mismo `RoomAccessForbiddenError` que ya usaba el chequeo de
`isParticipant`, y mismo patrón que `cancel()`: ownership antes que estado). Antes de esta ampliación cualquier
participante HUMAN podía iniciar; Web ahora solo expone el botón "Iniciar partida" al propietario en el lobby, pero
es Combat quien lo hace cumplir server-side — nunca solo el frontend.

`start` sigue siendo **idempotente para cualquier participante** (no solo el propietario): iniciar otra vez sobre
una sala ya `IN_BATTLE` devuelve el estado vigente sin otra cola, sin nuevo sorteo y sin otro `battleStarted`,
sin importar quién pregunte — necesario porque, tras `battleStarted`, cualquier cliente puede seguir consultando el
estado. Dos peticiones simultáneas del propietario se resuelven con el bloqueo optimista: la que pierde la carrera
relee la sala y devuelve la batalla ya iniciada por la otra.

## Dominio

Se **extiende `BattleRoom`** (ADR-019: la batalla es un único agregado) en lugar de crear otra entidad:

- `BattleRoomStatus.IN_BATTLE`.
- `BattleState`: la cola (`turnOrder`, inmutable y congelada) y **un único contador**, `turnsCompleted`. La
  posición activa (`turnsCompleted mod n`) y la ronda (`floor(turnsCompleted / n) + 1`) **se derivan**: no hay dos
  fuentes de verdad que puedan divergir, y volver al primero tras el último es aritmética, no un nuevo sorteo.
- `BattleEvent` (`battleStarted`, `turnAdvanced`) con `seq` creciente sin huecos, y `HandledCommand`
  (`commandId → seq`) para la deduplicación.
- `BattleRoom.startBattle(turnOrder, at)`: solo desde `PREPARING`; la cola debe ser **exactamente** la lista
  definitiva de participantes (nadie de más, nadie de menos). `BattleRoom.completeTurn(actor, commandId, at)`:
  solo el participante de la posición activa (o el servidor para un turno de `AI`); un `commandId` repetido
  devuelve la misma instancia y no avanza.
- En batalla la lista es definitiva: `leave` se rechaza (409), igual que `join` y `cancel`.
- `TurnOrderPolicy.generateTurnOrder(rosters, random)`: pura; solo recibe participantes por equipo y una fuente
  acotada, **ni siquiera recibe estadísticas**.

### Algoritmo de la cola (RF-17)

1. Equipo inicial: entero uniforme en `{0, 1}`.
2. Cada equipo se baraja con Fisher-Yates (decisiones aleatorias de HU-24).
3. Se intercalan los equipos empezando por el inicial (`A B A B …` o `B A B A …`).

**Solo se admiten equipos con el mismo número de participantes.** RF-17 exige alternar entre ambos equipos pero no
define qué ocurre cuando uno se agota antes (1 contra 3, 2 contra 3…), y esa regla no está ratificada: HU-17 **no la
inventa**. Con equipos de distinto tamaño `start` responde `422` con `code: UNSUPPORTED_TEAM_COMPOSITION`, **antes de
revalidar a nadie y sin consumir ningún sorteo**; no hay cola, no hay evento y la sala sigue `PREPARING`. Esto incluye
composiciones PVE de un humano contra varias IA. Impedir esas salas desde su creación (HU-14) sería un cambio aparte
que requiere una aclaración formal.

En 1 contra 1 la cola tiene exactamente dos entradas y el sorteado va primero.

## Aleatoriedad (HU-24) sin sesgo

`application/services/BoundedRandom.ts` construye `nextInt(bound)` sobre `RandomSequencePort.nextIndex()`. Como
8000 no es múltiplo de 3, 5 ni 6, `(índice − 1) mod bound` estaría sesgado: se usa **muestreo por rechazo**
(se acepta `v < 8000 − (8000 mod bound)`; en otro caso se toma otro índice, con tope de 64 intentos). Las pruebas
recorren los 8000 índices y comprueban que cada resultado aceptado aparece **el mismo número de veces**.

Selecciones por batalla: 1 para el equipo inicial y, por equipo de `k` integrantes, `k − 1` más los rechazos
(1v1: 1; 3v3: 5). No se usa `Math.random`, `crypto` (salvo el ticket, que es un secreto de autenticación y no
decide nada del juego), `Date.now`, otro MT19937 ni otra semilla; una prueba estática lo verifica.

### Semilla y ciclo de vida de la secuencia — decisión técnica separada

**Requisito de HU-17:** usar la semilla seleccionada y validada por HU-26 (`3.000.000`). El documento exige que la
semilla haya sido validada antes de producción, pero **no define** si la secuencia es global por proceso o por
batalla, si el cursor se persiste ni cómo se comporta tras un reinicio. HU-17 **no establece** ninguna de esas
políticas como requisito funcional, y `3.000.000` es la semilla validada por HU-26, no una «semilla global de
producción» decretada.

**Implementación provisional (detalle técnico, no ratificado):** para poder sortear, Combat crea una secuencia con
estado de proceso al arrancar, con esa semilla (`COMBAT_RANDOM_SEED`, por defecto `3.000.000`, entero sin signo de 32
bits), y cada sorteo avanza su estado. No se usa una semilla constante por batalla porque produciría siempre el mismo
equipo inicial. **Limitaciones (declaradas):** la secuencia vuelve a empezar al reiniciar Combat; el cursor no se
persiste; el resultado de una batalla no se puede reproducir por separado. Ninguna prueba de HU-17 depende de este
ciclo de vida (usan un generador guionizado). El ciclo de vida definitivo es una **decisión técnica separada**
(ADR-021 ya la dejaba abierta) y no bloquea ni forma parte de HU-17.

## Revalidación precombate (HU-16)

Al iniciar se repite, con los mismos puertos y la misma política que `JoinBattleRoom`
(`assessPrecombatEligibility`), la validación de cada participante `HUMAN`: debe tener héroe equipado
(`PlayerWithoutEquippedHeroError`), ser el mismo que se aprobó al unirse (`HERO_CHANGED_SINCE_JOIN`), seguir siendo
elegible (`ready`, formato) y conservar la `heroLoadoutVersion` capturada (`HERO_LOADOUT_CHANGED`). Si cualquiera
falla → `422` con `blockers[]`, **no hay cola ni evento** y la sala sigue `PREPARING`. Los `AI` no tienen héroe
equipado que validar. No se reimplementa el equipamiento: Player-Inventory sigue siendo su dueño.

De cada héroe solo se copia el **subtipo canónico** (para que Web elija el modelo visual); ninguna estadística.

## HTTP

| Método | Ruta                                 | Éxito                                  | Errores                                                                                                                 |
| ------ | ------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/combat/rooms/:roomId/start` | `200` sala + `battle`                  | `400`, `401`, `403` (no participante), `404`, `409`, `422` (`blockers[]` o `code: UNSUPPORTED_TEAM_COMPOSITION`), `503` |
| `GET`  | `/api/v1/combat/rooms/:roomId`       | `200` sala + `battle`                  | `400`, `401`, `403`, `404`                                                                                              |
| `POST` | `/api/v1/combat/realtime/tickets`    | `201` `{ticket, expiresInSeconds: 30}` | `401`                                                                                                                   |

`BattleRoomDto` se amplía de forma **aditiva** con `lastSeq` y `battle` (`null` hasta `IN_BATTLE`). Ver
`BattleView` en `domain/entities/BattleState.ts`: `battleId` (= `roomId`), `startedAt`, `turnOrder` (con
`position`), `turnsCompleted`, `round` y `currentTurn`. **Nunca** viajan la semilla, el estado del generador, el
número de sorteos, el inventario, el JWT ni los tickets.

## WebSocket (ADR-020)

`/api/v1/combat/realtime`, sin credenciales en la URL.

- **Ticket:** `POST …/tickets` (JWT verificado) → ticket opaco de 256 bits, **un solo uso**, ligado al `sub`,
  caduca a los **30 s**; solo se retiene su **hash** (SHA-256), en memoria (una sola réplica, ADR-020).
- **`auth`:** primer mensaje `{"type":"auth","ticket"}`; sin ticket válido en **5 s**, o con uno usado, caducado o
  desconocido → cierre `4401`. El esquema antiguo con el JWT en el mensaje (HU-15.2) **ya no se acepta**.
  El `sub` del ticket es la única identidad: ningún mensaje puede declarar otro jugador.
- **`subscribe`** (lobby, sin cambios): `battle-room.updated`.
- **`resume`** `{roomId, lastSeq?}`: solo participantes. `lastSeq` entre 1 y el último `seq` → reenvío ordenado de
  los eventos posteriores; ausente/inválido → `snapshot`; termina con `resume.ok`. Un no participante recibe
  `command.rejected` (`NOT_A_PARTICIPANT`) y no se suscribe.
  **Recuperación sin pérdida de eventos:** la conexión entra en modo «recuperando» **antes** de leer el estado y
  retiene los eventos que se publiquen mientras tanto; después entrega, en un único bloque síncrono, la lectura
  (replay o `snapshot`), lo retenido con `seq` posterior (se descarta lo que la lectura ya incluía y se corta ante un
  hueco, que el cliente detecta por `seq` y recupera con otro `resume`) y la suscripción, y por último `resume.ok`
  con el último `seq` **realmente entregado**. Un evento persistido y publicado entre la lectura y la suscripción
  llega igualmente, en orden y sin duplicarse. Dos `resume` de una misma conexión se serializan. La retención supone
  un único proceso publicador (una réplica), igual que el almacén de tickets.
- **Eventos con `seq`** (`battleStarted` = 1, `turnAdvanced`): solo a participantes que hicieron `resume`, siempre
  **después** de persistir; el mensaje se serializa una vez, así que todos reciben los mismos bytes.
- **Latido:** ping cada 25 s; sin pong, la conexión se corta (queda desconectada, no abandonada: HU-21).
- **Tamaño:** 16 KiB (`maxPayload`); mayor → la conexión se cierra.

> **Corrección heredada de HU-15.2:** el gateway se registraba con `useFactory`. Nest solo monta un
> `@WebSocketGateway` cuando el proveedor es la propia clase; con `useFactory` el _upgrade_ a WebSocket
> respondía `404`. Ahora se registra como clase con sus dependencias inyectadas con `@Inject`, y una prueba real
> contra un servidor con `ws` lo cubre.

## Avance de turno (server-side)

`CompleteBattleTurn` (`COMPLETE_BATTLE_TURN` en la raíz de composición) **no tiene ruta pública ni mensaje de
WebSocket**: lo invocan las acciones válidas al terminar. El ataque básico de HU-18 **no** lo llama como segundo
guardado: reutiliza `BattleState.completeTurn` dentro de la misma transición atómica que baja la Vida (una sola
escritura). Web nunca decide `turno + 1`. Es
idempotente por `commandId`, reintenta ante un conflicto de versión (máx. 3) y persiste antes de difundir
`turnAdvanced`. Dos cierres concurrentes con distinto `commandId` del participante activo → solo uno avanza.

## Persistencia

Todo en el **mismo documento** de `battle-rooms` (una escritura atómica con bloqueo optimista): `status`
admite `IN_BATTLE`; `battle` (cola + `turnsCompleted`); `events` (bitácora con `seq`); `handledCommands`.
Migración **aditiva** `005-battle-rooms-battle-state` (campos opcionales; sin backfill). Guardar el evento junto
al estado hace que «persistir la batalla» y «persistir el evento» sean la misma operación.

## Pruebas

- **Dominio:** cola 1v1/2v2/3v3, alternancia, equipos desiguales rechazados sin consumir sorteos, inmutabilidad,
  ronda, `commandId`, invariantes; solo el participante activo puede cerrar el turno (`NotYourTurnError`).
- **Aplicación:** inicio, revalidación (cada bloqueo), idempotencia, carrera, persistir antes de difundir, fallo de
  difusión, avance concurrente, `resume`/`snapshot`, tickets (un uso, 30 s, hash).
- **Gateway:** ticket, `4401`, `resume`, difusión solo a participantes, latido y la **carrera de `resume`**
  (evento publicado entre la lectura y la suscripción, duplicados, hueco, no participante, serialización; 4 de 4
  mutaciones detectadas).
- **HTTP (memoria):** `start`/`GET`/`tickets` con guards y errores.
- **Extremo a extremo de protocolo** (`test/db/battle-realtime.e2e.spec.ts`): **MongoDB real** (Testcontainers),
  servidor Nest real y **dos clientes `ws` reales**, cada uno con su `sub` y su ticket: `battleStarted` idéntico
  byte a byte, misma cola y mismo turno, avance del servidor, corte y `resume` con `lastSeq`, refresh con
  `snapshot`, reuso de ticket, `resume` ajeno, límite de 16 KiB, inicios simultáneos, **reinicio de Combat** y la
  **carrera de `resume`** (un `resume` detenido tras leer `seq N` mientras otro request persiste y publica `N + 1`:
  el cliente termina con `N + 1`).
- **Guarda estática** (`hu-17-no-alternative-randomness.spec.ts`): sin `Math.random`, `crypto` (salvo el ticket),
  reloj, MT19937, Box-Müller, CDF ni semilla en el código de HU-17.

## Fuera de alcance / pendientes

- Ataque, daño, habilidades, épicas, Poder y fin de batalla: HU-18, HU-19, HU-21.
- Abandono o desconexión durante la batalla (HU-21) y bloqueo del equipamiento (HU-29).
- Ciclo de vida de la secuencia aleatoria (por proceso o por batalla, persistencia del cursor): decisión técnica
  separada (ADR-021); no es requisito de HU-17.
- Orden de turnos con equipos de distinto tamaño: sin regla ratificada, HU-17 lo rechaza. Prohibir esas salas al
  crearlas (HU-14) requiere una aclaración formal.
- `CompleteBattleTurn` (caso de uso) sigue sin consumidor de producción: HU-18 avanza el turno dentro de su
  propia transición atómica (`BattleState.completeTurn`), y lo usarán las habilidades de HU-19 si conviene.
