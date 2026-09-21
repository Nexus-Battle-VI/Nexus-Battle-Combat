# HU-13 — Chat en sala de batalla y en el lobby

- **Historia:** [HU-13 #22](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/22) · **RF-13** · [EPIC-06 #6](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) · Team Alfa · milestone «M2 – Sprint 2 Review» (vence el 2026-09-27).
- **Arquitectura aplicada, sin reabrirla:** [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (Combat posee los mensajes de chat) y [ADR-020](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-020-realtime-combat.md) (`Accepted`: WebSocket nativo, `commandId`, `seq`). **No hay ADR nuevo.**
- **Contrato del protocolo:** [`docs/contracts/hu-13-chat-v1.md`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-13-chat-v1.md) en Infrastructure (si aún no está en `develop`, está en su PR de documentación).
- **Estado:** implementado en Combat, **sin caller de producción propio**: los clientes son Web (PR aparte) y cualquier cliente WebSocket autenticado. **No está desplegado**: `main` de Combat va por detrás de `develop` y el chat exige `npm run migrate` (migración `005`) al desplegar.

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

**Sin ninguna fuente, elegido por quien implementó** (el PO debe fijarlo o confirmarlo): **retención de 7 días** (`CHAT_RETENTION_HOURS=168`); historial de 50 mensajes al suscribirse (`CHAT_HISTORY_LIMIT`); umbral de consumidor lento de 1 MiB; 64 mensajes en cola por conexión; formato exacto de los mensajes y códigos de rechazo.

## Protocolo

Sobre el WebSocket existente (`/api/v1/combat/realtime`). La autenticación es la de HU-15.2 (`{"type":"auth","token"}`); el chat solo usa el `sub` de la conexión, así que hereda el ticket de un solo uso cuando HU-17 lo implemente. Todos los mensajes son JSON. **Ningún mensaje puede declarar otro jugador**: la identidad es el `sub` verificado.

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
| Chat disponible en el lobby y en la sala activa             | Dos canales (`lobby`, `room:<uuid>`); tabla exhaustiva `isRoomChatOpen` por estado                                                                                                         | `chat-access-policy`, `authorize-chat-channel`, `chat-realtime` (lobby y sala)                             |
| Enviar mensajes de texto desde el contexto en que se está   | `chat.send` al canal al que la conexión está suscrita (`NOT_SUBSCRIBED` si no)                                                                                                             | `send-chat-message`, `chat-realtime-handler`                                                               |
| Mensajes del lobby a los participantes de ese lobby         | Difusión solo a los suscritos a `lobby`                                                                                                                                                    | `chat-realtime-handler` (CA-01), `chat-realtime` (CA-01: lobby)                                            |
| Mensajes de una sala activa a los participantes de esa sala | Acceso solo a participantes HUMANOS, comprobado contra la sala **persistida** al suscribirse, al enviar y en cada actualización de la sala                                                 | `authorize-chat-channel`, `chat-realtime` (CA-01: sala, abandonar, cancelar)                               |
| Entrega en tiempo real por el mecanismo de la arquitectura  | WebSocket nativo de ADR-020, dentro del gateway existente                                                                                                                                  | `chat-realtime` (transporte `ws` real)                                                                     |
| Los mensajes de una sala no llegan a otra                   | La clave del canal indexa las suscripciones: difundir recorre SOLO los suscriptores de esa clave                                                                                           | `chat-realtime-handler` (aislamiento), `chat-realtime` (2 salas + lobby), latencia (40 salas)              |
| Operar sobre el canal WebSocket definido para el sistema    | El chat vive en el gateway de HU-15.2 (una ruta, un gateway) y hereda su autenticación                                                                                                     | `chat-gateway`, `chat-realtime`                                                                            |
| Un mensaje se procesa una sola vez; sin duplicados visibles | Índice único (`senderId`, `commandId`); el reintento devuelve `chat.accepted` con el mismo `seq` y **no se difunde de nuevo**; el cliente ignora `seq` repetido                            | `send-chat-message`, `chat-realtime-handler`, `mongo-chat-message-repository`, `chat-realtime`             |
| Un mensaje aceptado no se pierde                            | Persistir **antes** de difundir; `seq` por canal; recuperación con `lastSeq`; cerrojo por canal (una suscripción no se intercala con una difusión); consumidor lento cerrado y recuperable | `chat-realtime-handler` (orden, persistir→difundir, suscripción concurrente), `chat-realtime` (reconexión) |
| Aislamiento entre contextos                                 | Lo anterior + un jugador no puede escribir en un canal al que no está suscrito                                                                                                             | `chat-realtime-handler`                                                                                    |
| p95 < 500 ms                                                | Medición con conexiones reales y MongoDB real (ver más abajo)                                                                                                                              | `test/perf/chat-latency.spec.ts`                                                                           |

**CA-02 (frontera de cada regla).** Texto: 0, 1, máximo − 1, máximo y máximo + 1 caracteres; solo espacios; solo caracteres invisibles; control, salto de línea y sustituto suelto; un emoji cuenta uno, no dos. Frecuencia: el mensaje `max`, el `max + 1`, un milisegundo antes y justo en el instante en que se libera el hueco, y ventana deslizante frente a fija. Historial: `afterSeq` exacto, exactamente `limit` mensajes frente a `limit + 1`, expiración `expiresAt <= now`. Acceso: participante, ajeno, sala inexistente, cancelada, IA.

## Persistencia

Migración `005-chat-messages` (aditiva; `battle-rooms` no se toca), con validadores `$jsonSchema` (`additionalProperties: false`):

- **`chat-messages`**: un documento por mensaje aceptado. Índices: (`channelKey`, `seq`) **único**; (`senderId`, `commandId`) **único** (idempotencia); `expiresAt` **TTL** con `expireAfterSeconds: 0`. El instante de caducidad lo fija cada mensaje al crearse a partir de `CHAT_RETENTION_HOURS`, así que cambiar la retención no exige tocar el índice. El TTL de MongoDB purga con retraso (su monitor corre cada minuto): la lectura filtra `expiresAt > now` y no espera a la purga.
- **`chat-channels`**: contador de `seq` por canal. Aparte porque la purga de mensajes no debe reiniciar la numeración (un cliente que recuerda `lastSeq = 200` no puede encontrarse con un canal que vuelve a empezar en 1).

`seq` se reserva con `findOneAndUpdate` + `$inc` (atómico) y luego se inserta el mensaje. **Coste declarado:** si el `insertOne` falla después de reservar el número, o dos comandos idénticos coinciden, queda un **hueco** en `seq`. Es inocuo por diseño (`upTo`), y las pruebas contra MongoDB real lo fijan.

**El nodo de datos no es un replica set**, así que no hay transacciones: la idempotencia descansa en el índice único, no en «leer y luego escribir».

## Dos defectos heredados que había que corregir

Ambos afectan a **HU-15.2** (lo entregado antes de esta Historia) y ambos dejan sin funcionar cualquier cosa que viaje por el WebSocket, chat incluido. Los encontró la primera prueba con el transporte real (`test/integration/chat-realtime.spec.ts`); ninguna prueba anterior usaba un socket de verdad.

1. **El gateway nunca se registraba.** `app.module.ts` lo creaba con `useFactory`, y `@nestjs/websockets` **ignora los proveedores de fábrica** al buscar gateways (`socket-module.js` filtra `isNotMetatype`). Resultado: `/api/v1/combat/realtime` respondía **404** a la actualización a WebSocket. Corrección: proveedor de clase con `@Inject` (`adapters/inbound/ws/tokens.ts`). **Control:** con el registro antiguo, las 17 pruebas de transporte fallan con 404. Consecuencia en las pruebas: las cuatro suites que arrancan `AppModule` necesitan `app.useWebSocketAdapter(new WsAdapter(app))`, como ya hace `main.ts`.
2. **Carrera entre `auth` y el mensaje siguiente.** El gateway atendía cada mensaje sin esperar al anterior; un cliente que enviaba `auth` y `subscribe` seguidos —lo que hace `useBattleRoomRealtime` en Web— recibía `4401 no_autenticado`, porque `subscribe` se comprobaba antes de que terminara la verificación asíncrona del token. Medido contra el gateway de `develop` compilado y un cliente `ws` real: cierre con `auth` y `subscribe` seguidos (con verificador instantáneo y con uno lento); funcionaba con 100 ms de separación. Corrección: cola secuencial por conexión (`SerialQueue`).

**Lo que no se comprobó:** ninguno de los dos defectos se probó contra un Combat desplegado (el gateway ni siquiera está en `main`) ni en un navegador real.

## Relación con HU-17

El contrato de HU-17 (Infrastructure #116) define el ticket de un solo uso, `seq` por sala, `resume`, `commandId` y el latido, y retira la autenticación con JWT en el primer mensaje. HU-13 **no implementa el ticket**: el chat solo usa el `sub` de la conexión y hereda el cambio sin tocar nada. Solapes que quien aterrice segundo debe conciliar:

- **Latido (ADR-020, 25 s).** HU-13 lo implementa (sin él, una conexión a medio abrir sigue «suscrita» y el chat le difunde a un socket muerto). El contrato de HU-17 también lo asigna a HU-17.2: debe quedar **una** implementación.
- **Un solo gateway por ruta.** El chat es un manejador dentro de `BattleRoomRealtimeGateway`; HU-17.2 debe enrutar sus mensajes por el mismo sitio.
- **`seq`.** El de chat es por canal y separado del de batalla.

## Seguridad y privacidad

- Identidad = `sub` verificado; el cliente no elige remitente, sala ni nombre. El nombre visible sale del snapshot de la sala (si el participante lo tiene) o de Account, una vez por conexión.
- El `sub` no viaja a otros clientes. **El texto del mensaje no se registra** en los logs (solo canal, código y `commandId`).
- El texto se guarda y se envía **tal cual**; no se escapa HTML. Web debe pintarlo como texto, nunca como HTML.
- **Persistir mensajes asociados a un `sub` crea una categoría de dato nueva** que EN-011 no clasificó: su pendiente P2 pregunta si el chat entra en la exportación y en la eliminación de cuenta (HU-43). Esta Historia **no lo resuelve**: los mensajes caducan solos, pero mientras existen están asociados al remitente. Decisión del PO pendiente.
- Sin moderación en esta Historia: un jugador con un testimonio aún válido puede escribir hasta que expire, aunque su cuenta esté sancionada (HU-42).

## Rendimiento (p95 < 500 ms)

`npm run test:perf` (Docker; **no** forma parte del CI: una medición de tiempo en un ejecutor compartido no es estable). Mide, por pareja mensaje × destinatario, el tiempo entre `chat.send` y el `chat.message` recibido, con conexiones WebSocket reales, el módulo completo de Nest y **MongoDB real** (la escritura durable está incluida: ADR-020 obliga a persistir antes de difundir).

Los clientes corren en un **hilo aparte** (`worker_threads`) y la latencia se calcula dentro de él con un único reloj (`performance.now()` al escribir y al recibir). Se usa la configuración de producción del chat (5 mensajes cada 10 s por remitente y canal) y la reserva de conexiones por defecto del servicio (`maxPoolSize` 5). Tres corridas completas; se da el rango del p95. Cada escenario **además comprueba** que todos los clientes reciben todos los mensajes de su canal, en orden de `seq`, sin repetidos, sin rechazos y sin mensajes de otra sala; eso se cumplió en todas las corridas, también en los escenarios sobrecargados.

| Escenario                                                                                              | Carga                  |     p95 (3 corridas) | ¿p95 < 500 ms?          |
| ------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------: | ----------------------- |
| Lobby, 50 conexiones                                                                                   | 100 mensajes, 50 msg/s |       15,6 – 16,9 ms | Sí                      |
| Lobby, 200 conexiones                                                                                  | 100 mensajes, 50 msg/s |       30,1 – 48,1 ms | Sí                      |
| Lobby, 500 conexiones                                                                                  | 100 mensajes, 50 msg/s |     344,7 – 419,6 ms | **Sí, con poco margen** |
| Lobby, 1000 conexiones (límite observado)                                                              | 100 mensajes, 50 msg/s | 1 548,9 – 1 726,0 ms | **No**                  |
| 40 salas × 4 jugadores, **flujo sostenido** al máximo que admite el limitador (~80 msg/s)              | 800 mensajes           |       17,3 – 22,5 ms | Sí                      |
| 40 salas × 4 jugadores, **ráfaga sincronizada** (800 mensajes en ~0,4 s, ~2000 msg/s), reserva Mongo 5 | 800 mensajes           | 2 221,3 – 2 394,6 ms | **No**                  |
| Ídem con reserva Mongo 20                                                                              | 800 mensajes           | 1 973,3 – 2 279,1 ms | **No**                  |

Lectura, sin adornos:

- **Se cumple** con la carga que el propio limitador permite de forma sostenida (salas: p95 ≈ 20 ms) y con el lobby hasta 500 conexiones, aunque ahí el margen es corto (345 – 420 ms de 500).
- **No se cumple** con 1000 conexiones en el lobby ni con una ráfaga sincronizada de 160 jugadores agotando a la vez su cupo. El limitador **permite** esa ráfaga (5 mensajes por ventana y remitente); es el peor caso, no la carga esperada, pero no se defiende contra ella.
- **Por qué.** Cada mensaje del lobby cuesta una escritura por conexión, así que el trabajo crece con el número de conectados; con 1000 y 50 msg/s son 50 000 entregas por segundo en un único hilo. En la ráfaga se procesan ~350 – 450 mensajes/s por réplica (800 en 2,2 – 2,4 s), y el resultado es **casi igual con reserva de Mongo 5 y 20**: el límite es la CPU del proceso, no la reserva de conexiones. (Una primera versión de esta medición, con clientes y servidor en el mismo bucle de eventos, sugería que la reserva pesaba y variaba de 20 ms a 1 s entre corridas idénticas: era un artefacto de la propia prueba y se descartó.)
- **Consecuencia de producto.** Con una sola réplica y difusión en memoria (ADR-020), **un lobby global único no sostiene el objetivo mucho más allá de ~500 conexiones**. Para más habría que particionar el lobby (decisión de producto, p. ej. por modalidad) o introducir un bus de difusión (ADR nuevo). El documento oficial habla de 100 000 usuarios simultáneos en la beta: esta medición **no** lo demuestra.

**Qué NO demuestra:** los clientes corren en un hilo aparte pero en la misma máquina (no hay red y comparten CPU con el servidor y con MongoDB); MongoDB corre en un contenedor local, no en el nodo de datos; no es producción ni valida los 100 000 usuarios simultáneos del documento: ADR-020 fija **una** réplica de Combat con difusión en memoria del proceso, y escalar exigiría un bus de difusión y un ADR nuevo.

## Verificación

Todo ejecutado en local con el código de este PR:

| Comprobación                                         | Resultado                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run format:check`, `lint`, `typecheck`, `build` | Pasan                                                                                      |
| `npm run test:coverage` (unit + integration)         | **55 suites, 1553 pruebas** (base de `develop`: 43 y 1243; 12 suites y 310 pruebas nuevas) |
| Cobertura (umbral 80 %, sin tocar)                   | 97,41 % sentencias · 93,03 % ramas · 98,31 % funciones · 97,28 % líneas                    |
| `npm run test:db` (MongoDB 8 real, Testcontainers)   | **3 suites, 74 pruebas** (antes 2 y 19)                                                    |
| `npm run test:perf` (no está en el CI)               | Ver «Rendimiento»                                                                          |
| `git diff --check`                                   | Sin problemas                                                                              |

**Pruebas anteriores que hubo que tocar** (solo pruebas, ningún cambio de comportamiento pedido): `battle-room-realtime.gateway.spec.ts` (el gateway recibe ahora el manejador del chat y `RealtimeSocket` gana `pong`; las 9 pruebas de HU-15.2 siguen pasando) y las cuatro suites de integración que arrancan `AppModule` (`service-http`, `battle-room-http`, `randomness-wiring`, `attack-resolution-wiring`), que necesitan `app.useWebSocketAdapter(new WsAdapter(app))` ahora que Nest sí engancha el gateway.

**Transporte real.** `chat-realtime.spec.ts` (17 pruebas) usa el módulo completo, clientes `ws` de verdad y las rutas HTTP de salas. **Control:** con el registro antiguo del gateway (`useFactory`), las 17 fallan con `404` en la actualización a WebSocket.

**Controles de mutación** (defectos deliberados, uno por regla; el arnés no se versiona): **55 de 55 detectados** — 45 sobre la lógica (texto, frecuencia, acceso, deduplicación, historial, aislamiento, cerrojo, cola, latido, tamaño máximo, autenticación, registro del gateway) y 10 sobre MongoDB real (validador, índices únicos, TTL, contador atómico, `$gt`/`$gte`, expiración). Salvaguardas: jest sin _shell_, aborto si no hay resumen de pruebas, base verde obligatoria y que cada texto a mutar aparezca **exactamente una vez**. Dos primeros intentos (M18 y D03) no compilaban: eso **no** cuenta como detección, se marcaron «control inválido» y se rehicieron con una variante que compila. Los controles revelaron **un hueco real de las pruebas** (nada probaba que la suscripción revalidara el acceso bajo el cerrojo del canal ni que un mensaje aceptado durante la lectura del historial no se perdiera); se cerró con dos pruebas nuevas.

**Lo que ninguna de estas comprobaciones demuestra:** comportamiento contra un Combat desplegado, en un navegador real, con Cognito real, ni con más de una réplica.

## Limitaciones y pendientes

- **Una sola réplica.** Suscripciones, cerrojo por canal y limitador de frecuencia viven en la memoria del proceso (ADR-020). Con dos réplicas un mensaje no llegaría a quien esté conectado a la otra y el límite de frecuencia se multiplicaría.
- **Retención (7 días), historial (50), umbral de consumidor lento y cola por conexión:** cifras técnicas sin fuente; el PO debe fijar la primera.
- **EN-011 P2 y sanciones** (ver «Seguridad y privacidad»).
- **Sin moderación ni reportes.**
- **La frecuencia se consume en `prepare`:** si la escritura falla después, el remitente ya gastó un hueco. Es inocuo (el reintento con el mismo `commandId` no cuenta si ya se aceptó) y se prefiere a cobrar el hueco después de persistir, que permitiría una ráfaga concurrente por encima del límite.
- **Un jugador sin cuenta en Account** no puede escribir en el lobby (no hay nombre visible que mostrar) y recibe `ACCOUNT_PROFILE_NOT_FOUND`.
- **Despliegue.** No está en `main`; requiere `npm run migrate` (migración `005`) y promover `develop` a `main`. Combat corre con una sola identidad de AWS y sin cambios de infraestructura: Caddy ya enruta `/api/v1/combat*` al servicio.
