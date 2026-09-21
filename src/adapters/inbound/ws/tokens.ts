/**
 * Simbolos de inyeccion del gateway de tiempo real (HU-15.2, HU-13).
 *
 * Existen porque el gateway DEBE registrarse como proveedor de CLASE y no con
 * `useFactory`: `@nestjs/websockets` ignora los proveedores de fabrica al
 * buscar gateways (`socket-module.js`: filtra `isNotMetatype`), asi que un
 * gateway creado por fabrica nunca se engancha al servidor y `/api/v1/combat/
 * realtime` responde 404 a la actualizacion a WebSocket. Es lo que ocurria en
 * `develop` hasta HU-13, y solo lo delata una prueba con el transporte real
 * (`test/integration/chat-realtime.spec.ts`).
 */
export const REALTIME_LOGGER = Symbol('RealtimeLogger')

/** Periodo del latido en ms. Opcional: sin proveedor rige el de ADR-020 (25 s). */
export const REALTIME_HEARTBEAT_INTERVAL_MS = Symbol('RealtimeHeartbeatIntervalMs')
