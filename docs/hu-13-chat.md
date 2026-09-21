# HU-13 — Chat en sala de batalla y en el lobby

- **Historia:** [HU-13 #22](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/22) · **RF-13** · [EPIC-06 #6](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) · Team Alfa · milestone «M2 – Sprint 2 Review» (vence el 2026-09-27).
- **Arquitectura aplicada, sin reabrirla:** [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (Combat posee los mensajes de chat) y [ADR-020](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-020-realtime-combat.md) (`Accepted`: WebSocket nativo, `commandId`, `seq`). **No hay ADR nuevo.**
- **Contrato del protocolo:** [`docs/contracts/hu-13-chat-v1.md`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-13-chat-v1.md) en Infrastructure (integrado en `develop`: el contrato en #117 y su alineación con HU-17 en #118).
- **Estado:** implementado en Combat, **sin caller de producción propio**: los clientes son Web (PR aparte) y cualquier cliente WebSocket autenticado. **No está desplegado**: `main` de Combat va por detrás de `develop` y el chat exige `npm run migrate` (migración `006`, que va después de la `005` de HU-17) al desplegar.
- **Integrado con HU-17 el 2026-09-21.** Este trabajo se abrió antes de que HU-17 llegara a `develop`; al integrarlo (merge de `develop` en la rama) hubo que adaptar el chat a lo que HU-17 cambió: la autenticación por ticket, el latido, la migración (renumerada a `006`) y el estado `IN_BATTLE`. Ver «Relación con HU-17».

## Qué exige la Historia y de dónde sale

| Fuente                                             | Qué dice                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documento oficial, §7.6 «Módulo para Jugar online» | «Las salas de batalla, así como la vista general, deben tener un sistema de chat donde los jugadores puedan comunicarse para organizar nuevos juegos o chatear en medio de uno.»      |
| Documento oficial, §8                              | Latencias inferiores a 500 ms; «se deben entregar diseños, informes de pruebas de latencia y carga».                                                                                  |
| Documento oficial, §7.2                            | «Uso de lenguaje ofensivo o abusivo en comentarios o chat» es causal de sanción (relevante para la retención, ver más abajo).                                                         |
| Issue #22                                          | Chat en el lobby y en la sala activa; mensajes solo al contexto de origen; procesado una sola vez; sin pérdida; aislamiento entre contextos; p95 < 500 ms.                            |
| ADR-020                                            | WebSocket en `/api/v1/combat/realtime`; comando `chat` con `commandId`; `seq`; mensajes entrantes de hasta 16 KiB; una sola réplica; «longitud y frecuencia del chat las fija HU-13». |
| ADR-019 / ADR-020                                  | Retención y moderación del chat: **decisión de producto**.                                                                                                                            |

**Lobby = la «vista general» de Jugar Online** (§7.6), un único canal global. **Sala = el chat de una sala concreta.** Son los dos contextos; el resto es aislamiento entre ellos.

## Clasificación de lo que se decidió

**Explícito en un documento**: dos contextos (lobby y sala); WebSocket como transporte; `commandId` para procesar una vez; `seq`; 16 KiB por mensaje entrante; p95 < 500 ms; el servidor decide y el cliente solicita.

**Decidido por el PO por chat** (lo transmitió quien tiene la Historia asignada; **no consta por escrito en el issue**): las propuestas hechas al analizar la Historia. Es lo que fija cada cifra que la Historia dejaba en blanco:

| Decisión                  | Valor                                                                                                                                 | Dónde se cambia                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Longitud máxima del texto | 500 puntos de código Unicode                                                                                                          | `CHAT_MAX_MESSAGE_LENGTH`                 |
| Frecuencia                | 5 mensajes cada 10 s, por remitente y canal                                                                                           | `CHAT_RATE_LIMIT_MESSAGES` / `_WINDOW_MS` |
| Lobby                     | Un único canal global (no uno por modalidad)                                                                                          | `LOBBY_CHANNEL`                           |
| Moderación                | Fuera de HU-13 (§7.3.3 habla de comentarios, no del chat de juego); se conserva el remitente en el servidor para no cerrar esa puerta | —                                         |
| Persistencia              | Se persiste con caducidad configurable                                                                                                | `CHAT_RETENTION_HOURS`                    |

**Sin ninguna fuente, elegido por quien implementó** (el PO debe fijarlo o confirmarlo): **retención de 7 días** (`CHAT_RETENTION_HOURS=168`); historial de 50 mensajes al suscribirse (`CHAT_HISTORY_LIMIT`); umbral de consumidor lento de 1 MiB; 64 comandos de chat en cola por conexión; formato exacto de los mensajes y códigos de rechazo; **chat abierto también durante la batalla (`IN_BATTLE`)**, derivado de «sala activa» (ningún documento trata el chat de sala en batalla; el estado de batalla terminada lo decidirá HU-21).

## Protocolo

Sobre el WebSocket existente (`/api/v1/combat/realtime`). La autenticación es la de HU-17 (ADR-020): el cliente pide un **ticket de un solo uso** por HTTP (`POST /api/v1/combat/realtime/tickets`, con su JWT; responde `{ticket, expiresInSeconds: 30}`) y lo envía como **primer mensaje**, `{"type":"auth","ticket"}`; el servidor responde `auth.ok`. El JWT no viaja por el socket ni por la URL. El chat solo usa el `sub` del ticket. Todos los mensajes son JSON. **Ningún mensaje puede declarar otro jugador**: la identidad es el `sub` del ticket.

Los comandos de chat de una conexión se atienden **de uno en uno y en el orden en que llegaron**: `chat.subscribe` lee la sala y el historial (es asíncrono), y un cliente que envía `chat.subscribe` y `chat.send` seguidos espera que el segundo vea la suscripción del primero. La cola es solo de chat; `auth`, `subscribe` y `resume` de HU-17 no pasan por ella.

### Cliente → servidor

| Mensaje                                                          | Efecto                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `{"type":"chat.subscribe","channel":"lobby","lastSeq"?}`         | Se suscribe al lobby. Responde `chat.subscribed` con el historial retenido desde `lastSeq` (o el reciente).     |
| `{"type":"chat.subscribe","channel":"room","roomId","lastSeq"?}` | Igual para una sala. Solo participantes HUMANOS de una sala activa.                                             |
| `{"type":"chat.send","channel","roomId"?,"commandId","text"}`    | Envía un mensaje. `commandId` es un UUID que genera el cliente. Solo al canal al que la conexión está suscrita. |
| `{"type":"chat.unsubscribe","channel","roomId"?}`                | Deja de recibir. Responde `chat.unsubscribed` con `reason: "REQUESTED"`.                                        |

### Servidor → cliente

| Mensaje                                                                                          | A quién                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `chat.subscribed {channel, roomId?, upTo, truncated, messages[]}`                                | quien se suscribió                                      |
| `chat.message {messageId, channel, roomId?, seq, commandId, sender:{displayName}, text, sentAt}` | **todos los suscritos al canal, incluido el remitente** |
| `chat.accepted {commandId, seq, messageId, duplicate}`                                           | solo el remitente                                       |
| `chat.unsubscribed {channel, roomId?, reason}`                                                   | quien pidió salir, o el expulsado                       |
| `command.rejected {command, commandId?, code, retryAfterMs?, maxLength?}`                        | solo quien envió el comando                             |

Códigos de rechazo (`code`): `INVALID_COMMAND`, `EMPTY_MESSAGE`, `MESSAGE_TOO_LONG` (+`maxLength`), `INVALID_CHARACTERS`, `RATE_LIMITED` (+`retryAfterMs`), `NOT_SUBSCRIBED`, `ROOM_NOT_FOUND`, `ROOM_NOT_ACTIVE`, `NOT_A_PARTICIPANT`, `COMMAND_ID_REUSED`, `ACCOUNT_PROFILE_NOT_FOUND`, `CHAT_UNAVAILABLE`. El código es el contrato: el texto de los errores internos **no** viaja.

`chat.message` **no incluye el `sub` del remitente** (minimización de datos): un jugador del lobby que no comparte sala con otro no tiene por qué conocer su identificador de cuenta. Sí incluye `commandId`, que es un UUID que el propio cliente generó, para que el remitente reconcilie su mensaje optimista y para poder serializar UNA sola vez el mismo cuerpo para todos.

### Recuperación tras una desconexión

El cliente recuerda el último `seq` que aplicó por canal. Al reconectar envía `chat.subscribe` con `lastSeq`. La respuesta trae los mensajes retenidos con `seq` mayor y `upTo`, el último `seq` asignado en el canal: **el cliente está al día hasta `upTo`**, y un `seq` menor o igual que `upTo` que no llegó **no existe** (expiró, o su escritura falló después de reservar el número). `truncated: true` declara que había más mensajes de los que caben en el historial (`CHAT_HISTORY_LIMIT`): no se calla.

El cliente aplica solo `seq` mayor que el último aplicado; uno repetido o anterior se ignora. El `seq` del chat es **propio de cada canal** y **no comparte numeración** con los eventos de batalla de HU-17 (que van en el documento de la sala): mezclarlos engordaría ese documento sin límite y haría competir cada mensaje por su bloqueo optimista.

## Reglas del issue, mecanismo y prueba

| Regla del issue                                             | Mecanismo                                                                                                                                                                                  | Pruebas principales                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Chat disponible en el lobby y en la sala activa             | Dos canales (`lobby`, `room:<uuid>`); tabla exhaustiva `isRoomChatOpen` por estado: abierto en `WAITING_FOR_PLAYERS`, `PREPARING` e `IN_BATTLE`, cerrado en `CANCELLED`                    | `chat-access-policy`, `authorize-chat-channel`, `chat-realtime` (lobby y sala)                             |
| Enviar mensajes de texto desde el contexto en que se está   | `chat.send` al canal al que la conexión está suscrita (`NOT_SUBSCRIBED` si no)                                                                                                             | `send-chat-message`, `chat-realtime-handler`                                                               |
| Mensajes del lobby a los participantes de ese lobby         | Difusión solo a los suscritos a `lobby`                                                                                                                                                    | `chat-realtime-handler` (CA-01), `chat-realtime` (CA-01: lobby)                                            |
| Mensajes de una sala activa a los participantes de esa sala | Acceso solo a participantes HUMANOS, comprobado contra la sala **persistida** al suscribirse, al enviar y en cada actualización de la sala                                                 | `authorize-chat-channel`, `chat-realtime` (CA-01: sala, abandonar, cancelar)                               |
| Entrega en tiempo real por el mecanismo de la arquitectura  | WebSocket nativo de ADR-020, dentro del gateway existente                                                                                                                                  | `chat-realtime` (transporte `ws` real)                                                                     |
| Los mensajes de una sala no llegan a otra                   | La clave del canal indexa las suscripciones: difundir recorre SOLO los suscriptores de esa clave                                                                                           | `chat-realtime-handler` (aislamiento), `chat-realtime` (2 salas + lobby), latencia (40 salas)              |
| Operar sobre el canal WebSocket definido para el sistema    | El chat vive en el gateway (una ruta, un gateway) y usa la autenticación por ticket de HU-17                                                                                               | `chat-gateway`, `chat-realtime`                                                                            |
| Un mensaje se procesa una sola vez; sin duplicados visibles | Índice único (`senderId`, `commandId`); el reintento devuelve `chat.accepted` con el mismo `seq` y **no se difunde de nuevo**; el cliente ignora `seq` repetido                            | `send-chat-message`, `chat-realtime-handler`, `mongo-chat-message-repository`, `chat-realtime`             |
| Un mensaje aceptado no se pierde                            | Persistir **antes** de difundir; `seq` por canal; recuperación con `lastSeq`; cerrojo por canal (una suscripción no se intercala con una difusión); consumidor lento cerrado y recuperable | `chat-realtime-handler` (orden, persistir→difundir, suscripción concurrente), `chat-realtime` (reconexión) |
| Aislamiento entre contextos                                 | Lo anterior + un jugador no puede escribir en un canal al que no está suscrito                                                                                                             | `chat-realtime-handler`                                                                                    |
| p95 < 500 ms                                                | Medición con conexiones reales y MongoDB real (ver más abajo)                                                                                                                              | `test/perf/chat-latency.spec.ts`                                                                           |

**CA-02 (frontera de cada regla).** Texto: 0, 1, máximo − 1, máximo y máximo + 1 caracteres; solo espacios; solo caracteres invisibles; control, salto de línea y sustituto suelto; un emoji cuenta uno, no dos. Frecuencia: el mensaje `max`, el `max + 1`, un milisegundo antes y justo en el instante en que se libera el hueco, y ventana deslizante frente a fija. Historial: `afterSeq` exacto, exactamente `limit` mensajes frente a `limit + 1`, expiración `expiresAt <= now`. Acceso: participante, ajeno, sala inexistente, cancelada, IA.

## Persistencia

Migración `006-chat-messages` (aditiva; `battle-rooms` no se toca; la `005` es la de HU-17), con validadores `$jsonSchema` (`additionalProperties: false`):

- **`chat-messages`**: un documento por mensaje aceptado. Índices: (`channelKey`, `seq`) **único**; (`senderId`, `commandId`) **único** (idempotencia); `expiresAt` **TTL** con `expireAfterSeconds: 0`. El instante de caducidad lo fija cada mensaje al crearse a partir de `CHAT_RETENTION_HOURS`, así que cambiar la retención no exige tocar el índice. El TTL de MongoDB purga con retraso (su monitor corre cada minuto): la lectura filtra `expiresAt > now` y no espera a la purga.
- **`chat-channels`**: contador de `seq` por canal. Aparte porque la purga de mensajes no debe reiniciar la numeración (un cliente que recuerda `lastSeq = 200` no puede encontrarse con un canal que vuelve a empezar en 1).

`seq` se reserva con `findOneAndUpdate` + `$inc` (atómico) y luego se inserta el mensaje. **Coste declarado:** si el `insertOne` falla después de reservar el número, o dos comandos idénticos coinciden, queda un **hueco** en `seq`. Es inocuo por diseño (`upTo`), y las pruebas contra MongoDB real lo fijan.

**El nodo de datos no es un replica set**, así que no hay transacciones: la idempotencia descansa en el índice único, no en «leer y luego escribir».

## Dos defectos de HU-15.2 hallados al empezar (y qué quedó tras integrar HU-17)

Los encontró la primera prueba con el transporte real (`test/integration/chat-realtime.spec.ts`); ninguna prueba anterior usaba un socket de verdad. Ambos dejaban sin funcionar todo lo que viajara por el WebSocket, chat incluido.

1. **El gateway nunca se registraba.** `app.module.ts` lo creaba con `useFactory`, y `@nestjs/websockets` **ignora los proveedores de fábrica** al buscar gateways (`socket-module.js` filtra `isNotMetatype`). Resultado: `/api/v1/combat/realtime` respondía **404** a la actualización a WebSocket. **HU-17 lo encontró por su cuenta y lo corrigió igual** (proveedor de clase con `@Inject`) en su PR #26, que llegó a `develop` antes; al integrar no hubo nada que reconciliar salvo retirar mi versión duplicada. **Control que sigue vigente:** con el registro por fábrica, las 19 pruebas de transporte de chat fallan con 404 (mutación M45). Consecuencia en las pruebas: las suites que arrancan `AppModule` necesitan `app.useWebSocketAdapter(new WsAdapter(app))`, como ya hace `main.ts` (HU-17 lo añadió también).
2. **Carrera entre `auth` y el mensaje siguiente.** Con la autenticación por JWT en el primer mensaje, la verificación del token era asíncrona y el gateway atendía cada mensaje sin esperar al anterior: un cliente que enviaba `auth` y `subscribe` seguidos recibía `4401 no_autenticado`. Lo medí contra el gateway de `develop` de entonces, compilado, con un cliente `ws` real (cierre con `auth` y `subscribe` seguidos; funcionaba con 100 ms de separación). **HU-17 lo elimina de raíz:** consumir el ticket es **síncrono**, así que `auth` deja la identidad fijada antes de que llegue el mensaje siguiente. Mi cola por conexión ya no hace falta para la autenticación; se conservó **solo para los comandos de chat**, donde el orden sigue importando (`chat.subscribe` es asíncrono). Sobre el código integrado se comprobó con un cliente `ws` real que `auth`, `chat.subscribe` y `chat.send` enviados en el mismo instante funcionan y llegan en orden; el control (mutación M39) es quitar esa cola.

**Lo que no se comprobó:** ninguna de estas cosas se probó contra un Combat desplegado ni en un navegador real.

## Relación con HU-17

HU-17 (PR #26, ya en `develop`) implementó el ticket de un solo uso, `seq` por sala, `resume`, la orden de turnos y el latido, y retiró la autenticación con JWT en el primer mensaje. **Antes de integrar** este trabajo había un solape declarado en el contrato (`docs/contracts/hu-13-chat-v1.md`, §7); así se resolvió al integrar:

| Punto                    | Resolución                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticación            | Es la de HU-17 (ticket). El chat solo usa el `sub` del ticket; se eliminó el manejo de JWT en el socket que yo había heredado de HU-15.2.                                                                                                                                                                                                                                           |
| Latido (ADR-020, 25 s)   | **Es el de HU-17** (por conexión, con `terminate()`). Retiré el mío: debía quedar **una** implementación. Sigue protegido por su spec y por una prueba mía que comprueba que una conexión cortada por el latido se da de baja del chat.                                                                                                                                             |
| `maxPayload` de 16 KiB   | El de HU-17 (misma opción, mismo valor).                                                                                                                                                                                                                                                                                                                                            |
| Un solo gateway por ruta | El chat es un manejador dentro de `BattleRoomRealtimeGateway`; sus mensajes `chat.*` se enrutan ahí.                                                                                                                                                                                                                                                                                |
| `seq`                    | El de chat es **por canal** y no comparte numeración con el de batalla.                                                                                                                                                                                                                                                                                                             |
| Migración                | La de HU-17 es `005-battle-rooms-battle-state`; la del chat pasó a `006-chat-messages`. Ambas eran «la 005». El registro (`_migrations`) identifica cada migración por su **nombre completo**, así que con nombres distintos se habrían aplicado igual en el orden de la lista de `database.ts`; se renumeró para conservar una secuencia única y evitar la confusión de dos «005». |
| Estados de sala          | HU-17 añadió `IN_BATTLE`. La tabla exhaustiva de `ChatAccessPolicy` **impidió compilar** hasta decidirlo: queda abierto (ver «Clasificación»).                                                                                                                                                                                                                                      |

**Lo que sigue pendiente de coordinar con quien lleva HU-17:** (a) el contrato `docs/contracts/hu-13-chat-v1.md` ya se alineó con el ticket (Infrastructure #118, integrado en `develop`); falta que quien lleva HU-17 confirme que su descripción del ticket y del latido coincide con lo que implementó; (b) HU-21 (fin de batalla) añadirá un estado final y decidirá si su chat se cierra; (c) HU-18/HU-19 añadirán comandos de combate por este mismo gateway y por la misma vía de enrutado.

## Seguridad y privacidad

- Identidad = `sub` del ticket (emitido por HTTP tras verificar el JWT); el cliente no elige remitente, sala ni nombre. El nombre visible sale del snapshot de la sala (si el participante lo tiene) o de Account, una vez por conexión.
- El `sub` no viaja a otros clientes. **El texto del mensaje no se registra** en los logs (solo canal, código y `commandId`).
- El texto se guarda y se envía **tal cual**; no se escapa HTML. Web debe pintarlo como texto, nunca como HTML.
- **Persistir mensajes asociados a un `sub` crea una categoría de dato nueva** que EN-011 no clasificó: su pendiente P2 pregunta si el chat entra en la exportación y en la eliminación de cuenta (HU-43). Esta Historia **no lo resuelve**: los mensajes caducan solos, pero mientras existen están asociados al remitente. Decisión del PO pendiente.
- Sin moderación en esta Historia: un jugador con un testimonio aún válido puede pedir un ticket, conectarse y escribir hasta que expire el testimonio, aunque su cuenta esté sancionada (HU-42).

## Rendimiento (p95 < 500 ms)

`npm run test:perf` (Docker; **no** forma parte del CI: una medición de tiempo en un ejecutor compartido no es estable). Mide, por pareja mensaje × destinatario, el tiempo entre `chat.send` y el `chat.message` recibido, con conexiones WebSocket reales, el módulo completo de Nest y **MongoDB real** (la escritura durable está incluida: ADR-020 obliga a persistir antes de difundir). Cada conexión se autentica como en producción (ticket de un solo uso de HU-17; los tickets salen del caso de uso real, no de 1000 llamadas HTTP, porque el endpoint no es lo que se mide).

Los clientes corren en un **hilo aparte** (`worker_threads`) y la latencia se calcula dentro de él con un único reloj (`performance.now()` al escribir y al recibir). Se usa la configuración de producción del chat (5 mensajes cada 10 s por remitente y canal) y la reserva de conexiones por defecto del servicio (`maxPoolSize` 5). **Tres corridas completas sobre el código integrado con HU-17**; se da el rango del p95. Cada escenario **además comprueba** que todos los clientes reciben todos los mensajes de su canal, en orden de `seq`, sin repetidos, sin rechazos y sin mensajes de otra sala; eso se cumplió en todas las corridas, también en los escenarios sobrecargados.

| Escenario                                                                                 | Carga                  |     p95 (3 corridas) | ¿p95 < 500 ms?                     |
| ----------------------------------------------------------------------------------------- | ---------------------- | -------------------: | ---------------------------------- |
| Lobby, 50 conexiones                                                                      | 100 mensajes, 50 msg/s |       15,1 – 55,0 ms | Sí                                 |
| Lobby, 200 conexiones                                                                     | 100 mensajes, 50 msg/s |      26,5 – 274,5 ms | Sí                                 |
| Lobby, 500 conexiones                                                                     | 100 mensajes, 50 msg/s |   507,9 – 1 486,8 ms | **No de forma fiable** (ver abajo) |
| Lobby, 1000 conexiones (límite observado)                                                 | 100 mensajes, 50 msg/s | 1 888,2 – 2 880,0 ms | **No**                             |
| 40 salas × 4 jugadores, **flujo sostenido** al máximo que admite el limitador (~80 msg/s) | 800 mensajes           |       19,2 – 27,6 ms | Sí                                 |
| 40 salas × 4 jugadores, **ráfaga sincronizada** (800 mensajes en ~0,4 s), reserva Mongo 5 | 800 mensajes           | 2 595,7 – 3 294,0 ms | **No**                             |
| Ídem con reserva Mongo 20                                                                 | 800 mensajes           | 2 044,6 – 3 849,9 ms | **No**                             |

Lectura, sin adornos:

- **Se cumple, en todas las corridas,** con hasta 200 conexiones en el lobby y con la carga que el propio limitador permite de forma sostenida en las salas (p95 ≈ 20 – 28 ms).
- **Con 500 conexiones no puedo afirmarlo, y corrijo lo que escribí antes.** En una medición anterior (otra sesión, código previo a integrar HU-17) obtuve 344,7 – 419,6 ms y concluí «se cumple con poco margen». Hoy, con el código integrado, salió 507,9 – 1 486,8 ms. Para saber si el merge tuvo culpa hice un **control A/B** en la misma máquina, alternando el árbol anterior (`dae861c`) y el integrado, tres veces cada uno, solo en este escenario: **antes del merge 403 / 457 / 637 ms; integrado 376 / 579 / 800 ms**. Los rangos se solapan: no hay evidencia de que el merge cambie la latencia, y sí de que **el resultado varía mucho entre corridas con el mismo código** (345 a 637 ms; no medí la carga de la máquina, así que no atribuyo la dispersión a una causa concreta). Con esa dispersión, «cumple con 500» no es una afirmación que yo pueda sostener: la prueba de 500 conexiones ahora **informa** en lugar de afirmar.
- **No se cumple** con 1000 conexiones en el lobby ni con una ráfaga sincronizada de 160 jugadores agotando a la vez su cupo. El limitador **permite** esa ráfaga (5 mensajes por ventana y remitente); es el peor caso, no la carga esperada, pero no se defiende contra ella.
- **Por qué.** Cada mensaje del lobby cuesta una escritura por conexión, así que el trabajo crece con el número de conectados; con 1000 y 50 msg/s son 50 000 entregas por segundo en un único hilo. En la ráfaga no hay una diferencia consistente entre reserva de Mongo 5 y 20 (la de 5 salió mejor en 2 corridas de 3 y la de 20 en 1): el límite es la CPU del proceso, no la reserva de conexiones. (Una primera versión de esta medición, con clientes y servidor en el mismo bucle de eventos, sugería que la reserva pesaba y variaba de 20 ms a 1 s entre corridas idénticas: era un artefacto de la propia prueba y se descartó.)
- **Consecuencia de producto.** Con una sola réplica y difusión en memoria (ADR-020), **un lobby global único sostiene el objetivo con fiabilidad hasta 200 conexiones (lo medido)**; con 500 depende del estado de la máquina y con 1000 no lo cumple. Para más habría que particionar el lobby (decisión de producto, p. ej. por modalidad) o introducir un bus de difusión (ADR nuevo). El documento oficial habla de 100 000 usuarios simultáneos en la beta: esta medición **no** lo demuestra.

Para situar la dispersión, la medición anterior al merge (otra sesión) había dado: lobby 50 → 15,6 – 16,9 ms; 200 → 30,1 – 48,1; 500 → 344,7 – 419,6; 1000 → 1 548,9 – 1 726,0; salas sostenido → 17,3 – 22,5; ráfaga → 2 221,3 – 2 394,6 (reserva 5) y 1 973,3 – 2 279,1 (reserva 20).

**Qué NO demuestra:** los clientes corren en un hilo aparte pero en la misma máquina (no hay red y comparten CPU con el servidor y con MongoDB); MongoDB corre en un contenedor local, no en el nodo de datos; no es producción ni valida los 100 000 usuarios simultáneos del documento: ADR-020 fija **una** réplica de Combat con difusión en memoria del proceso, y escalar exigiría un bus de difusión y un ADR nuevo.

## Verificación

Todo ejecutado en local sobre el árbol **integrado con `develop` (HU-17)**:

| Comprobación                                         | Resultado                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run format:check`, `lint`, `typecheck`, `build` | Pasan                                                                   |
| `npm run test:coverage` (unit + integration)         | **63 suites, 1771 pruebas**                                             |
| Cobertura (umbral 80 %, sin tocar)                   | 97,83 % sentencias · 93,76 % ramas · 98,87 % funciones · 97,72 % líneas |
| `npm run test:db` (MongoDB 8 real, Testcontainers)   | **4 suites, 100 pruebas** (incluye el e2e de HU-17)                     |
| `npm run test:perf` (no está en el CI)               | Ver «Rendimiento» (incluye lo que **no** se cumple)                     |
| `git diff --check`                                   | Sin problemas                                                           |

**Pruebas de HU-17 que hubo que tocar:** solo `battle-room-realtime.gateway.spec.ts` (el gateway recibe ahora el manejador del chat; se le pasa un doble inerte en los dos sitios donde se construye; ningún caso cambió de sentido).

**Pruebas propias que hubo que reescribir por el ticket:** `chat-gateway.spec.ts` (sin las pruebas de la carrera de `auth` ni del latido, que ya no son de este cambio; con las del orden de los comandos de chat, la identidad, la cola y la baja al desconectar), `chat-realtime.spec.ts` (autenticación con ticket; **+2 pruebas**: el esquema anterior con JWT ya no autentica y un ticket usado no vuelve a servir), `chat-latency.spec.ts` (pide tickets como en producción) y `chat-access-policy.spec.ts` (una fila más en la tabla de estados: `IN_BATTLE`).

**Transporte real.** `chat-realtime.spec.ts` (19 pruebas) usa el módulo completo, clientes `ws` de verdad y las rutas HTTP de salas. **Control:** con el registro del gateway por `useFactory`, las 19 fallan con `404` en la actualización a WebSocket.

**Controles de mutación** (defectos deliberados, uno por regla; el arnés no se versiona): **58 de 58 detectados** — 48 sobre la lógica (texto, frecuencia, acceso —incluida la fila `IN_BATTLE`—, deduplicación, historial, aislamiento, cerrojo, cola, tamaño máximo, autenticación, identidad, enrutado y registro del gateway) y 10 sobre MongoDB real (validador, índices únicos, TTL, contador atómico, `$gt`/`$gte`, expiración). Salvaguardas: jest sin _shell_, aborto si no hay resumen de pruebas, base verde obligatoria y que cada texto a mutar aparezca **exactamente una vez**. Dos primeros intentos (M18 y D03) no compilaban: eso **no** cuenta como detección, se marcaron «control inválido» y se rehicieron con una variante que compila. Los controles revelaron **un hueco real de las pruebas** (nada probaba que la suscripción revalidara el acceso bajo el cerrojo del canal ni que un mensaje aceptado durante la lectura del historial no se perdiera); se cerró con dos pruebas nuevas. Al integrar con HU-17 se revisó el arnés: salió el control del latido (ahora es de HU-17), se reescribieron los del gateway contra el código integrado y entraron tres nuevos (enrutado de `chat.*`, remitente tomado del mensaje en lugar del ticket, cola de chat compartida entre conexiones) y uno de estado (`IN_BATTLE`).

**Lo que ninguna de estas comprobaciones demuestra:** comportamiento contra un Combat desplegado, en un navegador real contra Combat, con Cognito real, ni con más de una réplica.

## Limitaciones y pendientes

- **Una sola réplica.** Suscripciones, cerrojo por canal y limitador de frecuencia viven en la memoria del proceso (ADR-020). Con dos réplicas un mensaje no llegaría a quien esté conectado a la otra y el límite de frecuencia se multiplicaría.
- **Retención (7 días), historial (50), umbral de consumidor lento y cola por conexión:** cifras técnicas sin fuente; el PO debe fijar la primera.
- **EN-011 P2 y sanciones** (ver «Seguridad y privacidad»).
- **Sin moderación ni reportes.**
- **La frecuencia se consume en `prepare`:** si la escritura falla después, el remitente ya gastó un hueco. Es inocuo (el reintento con el mismo `commandId` no cuenta si ya se aceptó) y se prefiere a cobrar el hueco después de persistir, que permitiría una ráfaga concurrente por encima del límite.
- **Un jugador sin cuenta en Account** no puede escribir en el lobby (no hay nombre visible que mostrar) y recibe `ACCOUNT_PROFILE_NOT_FOUND`.
- **Despliegue.** No está en `main`; requiere `npm run migrate` (migración `006`) y promover `develop` a `main`. El almacén de tickets de HU-17 también vive en la memoria del proceso: una réplica (ADR-020). Combat corre con una sola identidad de AWS y sin cambios de infraestructura: Caddy ya enruta `/api/v1/combat*` al servicio.
