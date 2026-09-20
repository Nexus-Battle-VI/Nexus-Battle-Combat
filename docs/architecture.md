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
- **Tiempo real** (ADR-020): WebSocket en `/api/v1/combat/realtime` a través de Caddy, con ticket de un solo uso.

Todas las llamadas salientes que mueven créditos o productos siguen el patrón de ADR-019:

1. Persistir la intención con un `operationId` antes de llamar.
2. Reservar en el dueño del recurso con ese `operationId`.
3. Capturar o liberar según el resultado del propio agregado.
4. Toda reserva nace con caducidad; `409` y `503` no autorizan a suponer que la operación no ocurrió: se reintenta con el mismo `operationId`.

## Motor pseudoaleatorio (HU-24)

Implementado como puerto `RandomSequenceFactoryPort` (`application/ports/RandomSequencePort.ts`) con adaptador en `adapters/outbound/system`: **MT19937 → Box-Müller → estrategia normal→índice → `RandomIndex` (1..8000)**. La lógica de combate consume solo `RandomSequencePort.nextIndex()`; la normal cruda (`NormalSequencePort`) es un objeto independiente reservado a validación y no desplaza los índices. La semilla se entrega al crear una secuencia con estado; no hay singleton ni cursor global, y ningún cliente conoce semilla, estado ni índice. La estrategia normal→índice es una **decisión técnica provisional** y está aislada en `NormalToIndexMapper`. Aún **no lo consume ningún caso de uso** (HU-25 y la simulación para Missions lo harán) y no se creó ninguna ruta. Detalle, evidencia y decisiones pendientes en [hu-24-randomness-engine.md](hu-24-randomness-engine.md).

## Tabla de control de efectos aleatorios (HU-25)

Dominio puro en `domain/random-effects` (`EffectControlTable`, `ProbabilityModifier`, `BaseEffectProfiles`) y el caso de uso `ResolveRandomEffect`, que consume **solo** `RandomSequencePort.nextIndex()` (HU-24) y resuelve el efecto y su magnitud relativa. Combat sigue siendo la única autoridad: el cliente no selecciona fila ni efecto y no hay endpoint. Todavía **no lo invoca ningún flujo de batalla** (HU-20) y **nadie construye la tabla a partir del héroe equipado real** (Player-Inventory aún no entrega los modificadores). Detalle y pendientes en [hu-25-effect-control-table.md](hu-25-effect-control-table.md).

## Validación estadística de la semilla (HU-26)

Estudio **offline** (`tools/hu-26/`, evidencia en `docs/evidence/hu-26/`): genera muestras con `createNormalSequence(seed).nextNormal()` del código productivo y las analiza con Python (KS, Ljung-Box, Q-Q, momentos). No forma parte del runtime ni de la imagen, no añade endpoints ni persistencia y no se ejecuta en el hot path. Resultado y limitaciones en [hu-26-seed-validation.md](hu-26-seed-validation.md). **No existe todavía una política de semilla por batalla**: la semilla seleccionada es una referencia validada, no una configuración global.

## Contrato previsto

- `POST /api/v1/combat/rooms` y `GET /api/v1/combat/rooms` — crear y listar salas (HU-14, implementado).
- `POST /api/v1/combat/rooms/{roomId}/cancel` — el creador cancela una sala propia en `WAITING_FOR_PLAYERS` (HU-14, implementado; ver `HU-14.1-Contrato-Creacion-Sala.md`, sección 3, para la justificación del verbo/ruta).
- `POST /api/v1/combat/rooms/{roomId}/participants` — unirse (HU-15, no implementado).
- `POST /api/v1/combat/realtime/tickets` — ticket para el WebSocket.
- `POST /api/internal/v1/combat/simulations` — simulación para Missions.

## Temporizadores

Los vencimientos usan un intervalo dentro del proceso, apagado por defecto, con reclamación durable en el almacén (arrendamiento con `findOneAndUpdate`). El estado vive en la base: un reinicio retrasa un vencimiento, no lo pierde. Mismo patrón que `AccountDeletionProcessingScheduler` en Account.

## Decisiones abiertas

- HU-17 está en M2 pero depende de HU-14, HU-15 y HU-16, que no tienen milestone.
- Retención y moderación del chat (HU-13): decisión de producto antes de persistirlo más allá de la sala.
- ADR-020 sigue `Proposed`: no añadir WebSocket hasta su aceptación.
