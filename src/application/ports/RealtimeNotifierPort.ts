/**
 * Notificacion en tiempo real de una sala de batalla (HU-15.2, RF-15,
 * ADR-020 de Nexus-Battle-Infrastructure -- WebSocket nativo).
 *
 * Payload MINIMO: `roomId`, `status`, `version`. Nada mas -- ni
 * participantes ni equipos: un cliente suscrito ya conoce el `roomId` que
 * pidio, y ADR-020 deja la instantanea completa para el flujo de
 * reconexion/`resume` (fuera del alcance vertical de esta tarea, ver el
 * informe final, seccion "Gateway WebSocket").
 */
export interface BattleRoomUpdatedEvent {
  readonly roomId: string
  readonly status: string
  readonly version: number
}

/**
 * Puerto de salida hacia el transporte en tiempo real. La implementacion
 * concreta (`adapters/inbound/ws/BattleRoomRealtimeGateway.ts`) tambien es
 * un ADAPTADOR DE ENTRADA (acepta conexiones WebSocket) -- aqui actua como
 * salida, exactamente igual que `BattleRoomRepositoryPort` es un puerto de
 * la capa de aplicacion aunque su implementacion Mongo tambien lee.
 *
 * Quien invoca este puerto (`battle-room.controller.ts`) NO conoce el
 * transporte: podria ser WebSocket, SSE o nada (un no-op en pruebas), mismo
 * criterio de separacion que el resto del proyecto.
 */
export interface RealtimeNotifierPort {
  notifyRoomUpdated(event: BattleRoomUpdatedEvent): void
}

export const REALTIME_NOTIFIER = Symbol('RealtimeNotifierPort')
