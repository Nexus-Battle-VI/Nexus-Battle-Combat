# Arquitectura de Combat

Fuente de la decisión: [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md).
Este documento describe lo **previsto**; los contratos exactos se publican como OpenAPI en `Nexus-Battle-Infrastructure/docs/contracts` antes de implementarse.

## Responsabilidad

Implementa Jugar Online: salas y lobby, batallas por turnos con autoridad única del estado, el motor de reglas de combate, el generador centralizado de aleatoriedad y el chat. Es el **único** lugar del producto donde se ejecutan reglas de combate: Missions le pide simulaciones en lugar de duplicarlas.

## Datos que posee

- Salas y lobby: modalidad, cupo, composición humana/IA, recompensa, estado.
- Batallas: participantes, orden de turnos, vida, Poder, efectos activos y bitácora.
- Semillas y simulaciones (para reproducir un resultado sin exponerlo mientras está abierto).
- Mensajes de chat de sala y lobby.

Motor: **MongoDB**, base lógica `combat` con usuario y credenciales propios en el nodo de datos.

## Invariantes que debe imponer el motor

- La batalla es un documento con versión: toda escritura usa bloqueo optimista.
- Validadores `$jsonSchema` con `additionalProperties: false`, como en Catalog y Player/Inventory.
- Ningún resultado aleatorio sale del servidor antes de aplicarse.

## Integraciones

- **Player/Inventory** (síncrono, `operationId`): perfil de combate del héroe y compromiso `BATTLE`.
- **Wallet** (síncrono, `operationId`): reservar apuestas, transferir al ganador, liberar al cancelar.
- **Entrada interna** (`/api/internal/v1/combat/simulations`, HMAC): Missions ejecuta simulaciones.
- **Tiempo real** (ADR-020, `Accepted`): WebSocket en `/api/v1/combat/realtime` a través de Caddy. Implementado: aviso de cambios de sala (HU-15.2); ticket de un solo uso, `seq` de batalla y `resume` (HU-17); y chat (HU-13, con su propio `seq` por canal).

Todas las llamadas salientes que mueven créditos o productos siguen el patrón de ADR-019:

1. Persistir la intención con un `operationId` antes de llamar.
2. Reservar en el dueño del recurso con ese `operationId`.
3. Capturar o liberar según el resultado del propio agregado.
4. Toda reserva nace con caducidad; `409` y `503` no autorizan a suponer que la operación no ocurrió: se reintenta con el mismo `operationId`.

## Motor pseudoaleatorio (HU-24)

Implementado como puerto `RandomSequenceFactoryPort` (`application/ports/RandomSequencePort.ts`) con adaptador en `adapters/outbound/system`: **MT19937 → Box-Müller → estrategia normal→índice → `RandomIndex` (1..8000)**. La lógica de combate consume solo `RandomSequencePort.nextIndex()`; la normal cruda (`NormalSequencePort`) es un objeto independiente reservado a validación y no desplaza los índices. La semilla se entrega al crear una secuencia con estado; no hay singleton ni cursor global, y ningún cliente conoce semilla, estado ni índice. La estrategia normal→índice es una **decisión técnica provisional** y está aislada en `NormalToIndexMapper`. Aún **no lo consume ningún caso de uso** (HU-25 y la simulación para Missions lo harán) y no se creó ninguna ruta. Detalle, evidencia y decisiones pendientes en [hu-24-randomness-engine.md](hu-24-randomness-engine.md).

## Tabla de control de efectos aleatorios (HU-25)

Dominio puro en `domain/random-effects` (`EffectControlTable`, `ProbabilityModifier`, `BaseEffectProfiles`) y el caso de uso `ResolveRandomEffect`, que consume **solo** `RandomSequencePort.nextIndex()` (HU-24) y resuelve el efecto, su magnitud relativa y su porcentaje concreto. Combat sigue siendo la única autoridad: el cliente no selecciona fila ni efecto y no hay endpoint. `BuildHeroEffectTable` construye la tabla a partir del héroe equipado real (`subtype` y `activeEffects` del contrato interno de Player-Inventory, con parser estricto en `PlayerInventoryHttpClient`), traduce `CRITICAL_CHANCE` a `ProbabilityModifier` (100 pb = +1 punto porcentual absoluto, regla local a la tabla) y declara como pendientes los efectos cuya semántica no está definida. Detalle en [hu-25-effect-control-table.md](hu-25-effect-control-table.md).

## Resultado de un ataque (HU-20)

`domain/policies/AttackResolutionPolicy` (Ataque > Defensa, la igualdad no supera) y `AttackProfile` (dado de Ataque por subtipo, Tabla 6), más los casos de uso `prepareAttack` (dos héroes equipados → Ataque, Defensa y tabla) y `ResolveAttack` (tira el dado, compara y, solo si el golpe es efectivo, invoca `ResolveRandomEffect`). Toda la aleatoriedad, dado incluido, sale de `RandomSequencePort.nextIndex()`. Todavía **no lo invoca ningún flujo de batalla** (HU-17, HU-18), **no está registrado en `app.module.ts`** y **no hay endpoint**: un cliente que aportara el Ataque o la Defensa podría manipular el resultado. No calcula daño numérico ni vida (HU-18). Detalle en [hu-20-attack-resolution.md](hu-20-attack-resolution.md).

## Chat del lobby y de las salas (HU-13)

Manejador (`adapters/inbound/ws/ChatRealtimeHandler`) dentro del gateway existente: la ruta es una sola y `@nestjs/platform-ws` enruta cada conexión por ruta al primer gateway que la declara. Dos contextos, `lobby` (un canal global) y `room:<uuid>` (solo participantes humanos, sala activa). Casos de uso `AuthorizeChatChannel`, `SendChatMessage` (en dos fases: `prepare` valida, deduplica y limita la frecuencia; `commit` persiste bajo el cerrojo del canal) y `ReadChatHistory`. Persistencia en dos colecciones (`chat-messages`, con índices únicos y TTL, y `chat-channels`, el contador de `seq`). Los mensajes de una conexión se atienden en orden (`SerialQueue`) y persistencia y difusión de un canal son secuenciales (`ChannelLock`). Detalle, protocolo, trazabilidad a pruebas, mediciones y limitaciones en [hu-13-chat.md](hu-13-chat.md).

## Contrato previsto

- `POST /api/v1/combat/rooms` y `GET /api/v1/combat/rooms` — crear y listar salas (HU-14, implementado).
- `POST /api/v1/combat/rooms/{roomId}/cancel` — el creador cancela una sala propia en `WAITING_FOR_PLAYERS` (HU-14, implementado; ver `HU-14.1-Contrato-Creacion-Sala.md`, sección 3, para la justificación del verbo/ruta).
- `POST /api/v1/combat/rooms/{roomId}/participants` — unirse (HU-15, no implementado).
- `POST /api/v1/combat/realtime/tickets` — ticket para el WebSocket (HU-17, implementado).
- `GET /api/v1/combat/rooms/{roomId}` y `POST /api/v1/combat/rooms/{roomId}/start` — leer una sala y iniciar su batalla, solo participantes (HU-17, implementado).
- WebSocket `/api/v1/combat/realtime` — `chat.subscribe`, `chat.send`, `chat.unsubscribe` (HU-13, implementado; protocolo en [hu-13-chat.md](hu-13-chat.md)).
- `POST /api/internal/v1/combat/simulations` — simulación para Missions.

## Temporizadores

Los vencimientos usan un intervalo dentro del proceso, apagado por defecto, con reclamación durable en el almacén (arrendamiento con `findOneAndUpdate`). El estado vive en la base: un reinicio retrasa un vencimiento, no lo pierde. Mismo patrón que `AccountDeletionProcessingScheduler` en Account.

## Decisiones abiertas

- HU-17 (orden de turnos) está implementada; ver `docs/hu-17-turn-order.md`. Los equipos de distinto tamaño se rechazan (no hay regla ratificada) y el ciclo de vida de la secuencia aleatoria es una decisión técnica separada (la semilla es la validada por HU-26).
- Retención y moderación del chat (HU-13): el chat se persiste con una **retención de 7 días que no tiene fuente** (el PO debe fijarla) y sin moderación. Además, EN-011 P2 pregunta si el chat entra en la exportación y eliminación de datos personales.
- Escala del lobby: un único canal global con una sola réplica no sostiene el objetivo de 500 ms con 1000 conexiones (medido); más allá exigiría particionar el lobby (decisión de producto) o un bus de difusión (ADR nuevo).
- ADR-020 está `Accepted` y el WebSocket con ticket, `seq` y `resume` está implementado (HU-15.2 y HU-17).
