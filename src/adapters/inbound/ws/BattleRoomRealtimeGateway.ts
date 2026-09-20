import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets'

import type { BattleRoomRepositoryPort } from '../../../application/ports/BattleRoomRepositoryPort'
import type {
  BattleRoomUpdatedEvent,
  RealtimeNotifierPort,
} from '../../../application/ports/RealtimeNotifierPort'
import {
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../../application/ports/TokenVerifierPort'
import type { Logger } from '../../../infrastructure/observability/logger'

/**
 * Gateway WebSocket de HU-15.2 (RF-15, ADR-020 de Nexus-Battle-Infrastructure
 * -- Accepted, WebSocket NATIVO, `@nestjs/websockets` + `@nestjs/platform-ws`,
 * nunca Socket.IO).
 *
 * MINIMO VERTICAL APROBADO PARA ESTA TAREA, NO EL ADR-020 COMPLETO: el ADR
 * describe ademas tickets de un solo uso, comandos de combate
 * (`join`/`ready`/`attack`/`useSkill`/`chat`), numero de secuencia `seq` y
 * reanudacion (`resume`) -- ese protocolo completo es para HU-13/HU-17
 * (chat y turnos), fuera del alcance de HU-15.2. Esta version implementa
 * solo lo que RF-15 necesita: notificar `battle-room.updated` tras un join
 * o una cancelacion validos.
 *
 * SIMPLIFICACION DOCUMENTADA vs. el flujo de ticket de ADR-020: en vez de
 * `POST /realtime/tickets` + ticket opaco de un solo uso, el primer mensaje
 * del cliente lleva el JWT de Cognito tal cual (`{"type":"auth","token":
 * "..."}`) y se verifica con EL MISMO `TokenVerifierPort` que ya usa el
 * resto de Combat (`JwtAuthGuard`) -- "mismo mecanismo que ya usa el resto
 * de Combat", tal como pide esta tarea. El JWT NUNCA viaja en la URL (mismo
 * principio que motiva el ticket en el ADR): solo en el primer mensaje, ya
 * con la conexion establecida. El ticket de un solo uso queda para cuando
 * HU-13/HU-17 implementen el protocolo de comandos completo.
 *
 * SCOPE POR SALA: una conexion no recibe NADA hasta que envia
 * `{"type":"subscribe","roomId":"..."}` autenticada, y el servidor autoriza
 * la suscripcion comprobando que la sala existe
 * (`BattleRoomRepositoryPort.findById`) -- una sala inexistente no se
 * suscribe en silencio. Los eventos de una sala SOLO llegan a las conexiones
 * suscritas a ESE `roomId` (aislamiento entre salas).
 *
 * LIMITACION CONOCIDA (documentada, no oculta): sin ticket, autenticacion en
 * el primer mensaje en vez de en el handshake, y sin `seq`/`resume`/latido —
 * ver el informe final de esta tarea, seccion "Gateway WebSocket", para la
 * lista completa de lo que este vertical NO cubre y su traza hacia
 * HU-13/HU-17.
 */
export interface RealtimeSocket {
  readonly readyState: number
  on(event: 'message', listener: (data: RealtimeSocketData) => void): void
  on(event: 'close', listener: () => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Lo que `ws` entrega en el evento `message`: `Buffer`, `ArrayBuffer` o similar con `toString()`. */
export interface RealtimeSocketData {
  toString(): string
}

/** Cierre por falta de autenticacion o ticket/token invalido (ADR-020, seccion "Autenticacion"). */
const CLOSE_UNAUTHENTICATED = 4401
/** Cierre por un mensaje que no es JSON valido o no declara un `type` reconocido. */
const CLOSE_BAD_MESSAGE = 4400
/** Segundos que ADR-020 concede para autenticarse tras conectar. */
const AUTH_TIMEOUT_MS = 5_000

interface ConnectionState {
  subject: string | null
  roomId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
}

@WebSocketGateway({
  // Literal, no derivado de `AppConfig.globalPrefix`: la metadata del
  // decorador es estatica (se evalua al cargar la clase, antes de que exista
  // el contenedor de DI). Coincide con el valor por defecto de
  // `GLOBAL_PREFIX` ('api') y con la ruta exacta de ADR-020.
  path: '/api/v1/combat/realtime',
})
export class BattleRoomRealtimeGateway
  implements
    OnGatewayConnection<RealtimeSocket>,
    OnGatewayDisconnect<RealtimeSocket>,
    RealtimeNotifierPort
{
  @WebSocketServer()
  server: unknown

  private readonly connections = new Map<RealtimeSocket, ConnectionState>()

  constructor(
    private readonly tokenVerifier: TokenVerifierPort,
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly logger: Logger,
  ) {}

  handleConnection(client: RealtimeSocket): void {
    const state: ConnectionState = {
      subject: null,
      roomId: null,
      authTimer: setTimeout(() => {
        // Sin `{"type":"auth", ...}` valido en la ventana de ADR-020: se
        // cierra con el codigo que declara la seccion "Autenticacion".
        client.close(CLOSE_UNAUTHENTICATED, 'auth_timeout')
      }, AUTH_TIMEOUT_MS),
    }
    this.connections.set(client, state)

    client.on('message', (data: RealtimeSocketData) => {
      void this.handleMessage(client, state, data)
    })
    client.on('close', () => {
      this.handleDisconnect(client)
    })
  }

  handleDisconnect(client: RealtimeSocket): void {
    const state = this.connections.get(client)

    if (state?.authTimer !== null && state?.authTimer !== undefined) {
      clearTimeout(state.authTimer)
    }

    // Limpieza explicita: sin esto, una conexion cerrada seguiria "suscrita"
    // en el mapa y `notifyRoomUpdated` intentaria escribir en un socket
    // muerto en cada evento futuro de esa sala.
    this.connections.delete(client)
  }

  /**
   * Puerto de salida (`RealtimeNotifierPort`): difunde SOLO a las conexiones
   * autenticadas y suscritas a `event.roomId` (aislamiento entre salas).
   * Payload minimo: `roomId`, `status`, `version` -- nada mas.
   */
  notifyRoomUpdated(event: BattleRoomUpdatedEvent): void {
    const payload = JSON.stringify({
      type: 'battle-room.updated',
      roomId: event.roomId,
      status: event.status,
      version: event.version,
    })

    for (const [client, state] of this.connections) {
      if (state.roomId === event.roomId && client.readyState === OPEN_STATE) {
        client.send(payload)
      }
    }
  }

  private async handleMessage(
    client: RealtimeSocket,
    state: ConnectionState,
    raw: RealtimeSocketData,
  ): Promise<void> {
    const message = parseMessage(raw)

    if (message === null) {
      client.close(CLOSE_BAD_MESSAGE, 'mensaje_invalido')
      return
    }

    if (message.type === 'auth') {
      await this.handleAuth(client, state, message)
      return
    }

    if (message.type === 'subscribe') {
      await this.handleSubscribe(client, state, message)
      return
    }

    // Tipo de mensaje no reconocido en este vertical minimo (comandos de
    // combate -- `ready`/`attack`/`useSkill`/`chat` -- son HU-13/HU-17).
    client.close(CLOSE_BAD_MESSAGE, 'tipo_no_reconocido')
  }

  private async handleAuth(
    client: RealtimeSocket,
    state: ConnectionState,
    message: Record<string, unknown>,
  ): Promise<void> {
    const token = message.token

    if (typeof token !== 'string' || token.length === 0) {
      client.close(CLOSE_UNAUTHENTICATED, 'token_ausente')
      return
    }

    try {
      const identity = await this.tokenVerifier.verify(token)

      if (state.authTimer !== null) {
        clearTimeout(state.authTimer)
        state.authTimer = null
      }
      state.subject = identity.subject

      client.send(JSON.stringify({ type: 'auth.ok' }))
    } catch (error: unknown) {
      const reason =
        error instanceof TokenVerificationError ? 'token_invalido' : 'error_verificacion'

      this.logger.warn('realtime_auth_rechazada', { reason })
      client.close(CLOSE_UNAUTHENTICATED, reason)
    }
  }

  private async handleSubscribe(
    client: RealtimeSocket,
    state: ConnectionState,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (state.subject === null) {
      // Nunca se acepta una suscripcion sin autenticar primero: el `sub` del
      // testimonio es la unica identidad de la conexion (ADR-020).
      client.close(CLOSE_UNAUTHENTICATED, 'no_autenticado')
      return
    }

    const roomId = message.roomId

    if (typeof roomId !== 'string' || roomId.length === 0) {
      client.close(CLOSE_BAD_MESSAGE, 'roomId_invalido')
      return
    }

    // El servidor AUTORIZA la suscripcion: una sala inexistente no se
    // suscribe en silencio, distinto de aceptar cualquier `roomId` sin
    // comprobar nada.
    const room = await this.rooms.findById(roomId)

    if (room === null) {
      client.close(CLOSE_BAD_MESSAGE, 'sala_inexistente')
      return
    }

    state.roomId = roomId
    client.send(JSON.stringify({ type: 'subscribe.ok', roomId }))
  }
}

const OPEN_STATE = 1

const parseMessage = (raw: RealtimeSocketData): Record<string, unknown> | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw.toString())
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }

  const record = parsed as Record<string, unknown>

  return typeof record.type === 'string' ? record : null
}
