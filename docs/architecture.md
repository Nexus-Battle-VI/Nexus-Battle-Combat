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
