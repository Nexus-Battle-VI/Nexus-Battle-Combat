import { Inject, Optional, type OnModuleDestroy } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets'

import {
  BATTLE_ROOM_REPOSITORY,
  type BattleRoomRepositoryPort,
} from '../../../application/ports/BattleRoomRepositoryPort'
import type {
  BattleRoomUpdatedEvent,
  RealtimeNotifierPort,
} from '../../../application/ports/RealtimeNotifierPort'
import {
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../../application/ports/TokenVerifierPort'
import type { Logger } from '../../../infrastructure/observability/logger'
import { CHAT_MESSAGE_TYPES, ChatRealtimeHandler } from './ChatRealtimeHandler'
import type { RealtimeSocket, RealtimeSocketData } from './RealtimeSocket'
import { SerialQueue } from './SerialQueue'
import { REALTIME_HEARTBEAT_INTERVAL_MS, REALTIME_LOGGER } from './tokens'

export type { RealtimeSocket, RealtimeSocketData } from './RealtimeSocket'

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
 *
 * AMPLIADO EN HU-13 (RF-13, chat del lobby y de las salas):
 *
 * - Los mensajes `chat.*` se delegan en `ChatRealtimeHandler`: el chat vive
 *   dentro de ESTE gateway porque la ruta es una sola. La auth sigue siendo la
 *   de HU-15.2 (JWT en el primer mensaje); cuando HU-17 implemente el ticket de
 *   un solo uso, el chat lo hereda sin cambios porque solo usa el `sub` de la
 *   conexion.
 * - Los mensajes de UNA conexion se atienden EN ORDEN (`SerialQueue`). Antes se
 *   atendian sin esperar al anterior, y un cliente que enviaba `auth` y
 *   `subscribe` seguidos -- lo que hace Web -- recibia `4401 no_autenticado`
 *   porque `subscribe` se comprobaba antes de que terminara la verificacion del
 *   token (medido con un cliente `ws` real; ver `SerialQueue`).
 * - Tamano maximo de mensaje entrante: 16 KiB (ADR-020, «Que viaja y que no»).
 *   Lo aplica `ws`, que cierra con 1009 al superarlo.
 * - Latido (ADR-020): el servidor envia un ping cada 25 s y cierra la conexion
 *   que no responde con pong antes del siguiente. Sin el, una conexion a medio
 *   abrir (red caida sin cierre) seguiria «suscrita» y el chat le difundiria a
 *   un socket muerto sin que nadie lo notara. El contrato de HU-17 (Infrastructure
 *   #116) tambien lo asigna a HU-17.2: quien aterrice segundo debe conservar UNA
 *   sola implementacion.
 */
/** Cierre por falta de autenticacion o ticket/token invalido (ADR-020, seccion "Autenticacion"). */
const CLOSE_UNAUTHENTICATED = 4401
/** Cierre por un mensaje que no es JSON valido o no declara un `type` reconocido. */
const CLOSE_BAD_MESSAGE = 4400
/** Cierre por exceso de mensajes en espera: RFC 6455, 1008 (violacion de politica). */
const CLOSE_POLICY_VIOLATION = 1008
/** Segundos que ADR-020 concede para autenticarse tras conectar. */
const AUTH_TIMEOUT_MS = 5_000
/** Tamano maximo de un mensaje entrante (ADR-020): 16 KiB. */
const MAX_INCOMING_PAYLOAD_BYTES = 16 * 1024
/** Periodo del latido del servidor (ADR-020): 25 s. */
export const HEARTBEAT_INTERVAL_MS = 25_000
/**
 * Mensajes de una conexion en espera de su turno. Decision tecnica: acota la
 * memoria que un cliente puede ocupar enviando mas rapido de lo que se atiende.
 * ADR-020 pide un limite de comandos por conexion «configurable»; este es el
 * limite de mensajes EN COLA, no la frecuencia (esa la limita el chat por
 * remitente y canal).
 */
const MAX_PENDING_MESSAGES = 64

interface ConnectionState {
  subject: string | null
  roomId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  /** Mensajes de esta conexion, atendidos de uno en uno y en orden de llegada. */
  readonly queue: SerialQueue
  /** `true` si respondio al ultimo ping (o aun no se le ha enviado ninguno). */
  alive: boolean
}

@WebSocketGateway({
  // Literal, no derivado de `AppConfig.globalPrefix`: la metadata del
  // decorador es estatica (se evalua al cargar la clase, antes de que exista
  // el contenedor de DI). Coincide con el valor por defecto de
  // `GLOBAL_PREFIX` ('api') y con la ruta exacta de ADR-020.
  path: '/api/v1/combat/realtime',
  // Se pasa tal cual a `ws`, que cierra con 1009 un mensaje mayor.
  maxPayload: MAX_INCOMING_PAYLOAD_BYTES,
})
export class BattleRoomRealtimeGateway
  implements
    OnGatewayConnection<RealtimeSocket>,
    OnGatewayDisconnect<RealtimeSocket>,
    OnModuleDestroy,
    RealtimeNotifierPort
{
  @WebSocketServer()
  server: unknown

  private readonly connections = new Map<RealtimeSocket, ConnectionState>()
  private heartbeat: ReturnType<typeof setInterval> | null = null

  /**
   * Se registra como proveedor de CLASE (no de fabrica): ver `tokens.ts`. Por
   * eso los parametros llevan `@Inject`, igual que los controladores.
   */
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly tokenVerifier: TokenVerifierPort,
    @Inject(BATTLE_ROOM_REPOSITORY) private readonly rooms: BattleRoomRepositoryPort,
    @Inject(REALTIME_LOGGER) private readonly logger: Logger,
    @Inject(ChatRealtimeHandler) private readonly chat: ChatRealtimeHandler,
    @Optional()
    @Inject(REALTIME_HEARTBEAT_INTERVAL_MS)
    private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
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
      queue: new SerialQueue(MAX_PENDING_MESSAGES, (error: unknown) => {
        this.logger.error('realtime_mensaje_fallo', {
          reason: error instanceof Error ? error.message : 'error desconocido',
        })
      }),
      alive: true,
    }
    this.connections.set(client, state)

    client.on('message', (data: RealtimeSocketData) => {
      const accepted = state.queue.push(() => this.handleMessage(client, state, data))

      if (!accepted) {
        client.close(CLOSE_POLICY_VIOLATION, 'demasiados_mensajes')
      }
    })
    client.on('pong', () => {
      state.alive = true
    })
    client.on('close', () => {
      this.handleDisconnect(client)
    })

    this.startHeartbeat()
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
    this.chat.onDisconnect(client)
  }

  onModuleDestroy(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  /**
   * Un unico temporizador para todas las conexiones, que arranca con la primera
   * y no mantiene vivo el proceso. Cada vuelta cierra las conexiones que no
   * respondieron al ping anterior y pide pong a las demas (ADR-020: una
   * conexion sin respuesta se cierra; queda desconectada, no abandonada).
   */
  private startHeartbeat(): void {
    if (this.heartbeat !== null) {
      return
    }

    this.heartbeat = setInterval(() => {
      for (const [client, state] of this.connections) {
        if (!state.alive) {
          // `terminate` corta sin esperar el cierre ordenado: la otra punta no responde.
          client.terminate?.()
          continue
        }

        state.alive = false
        client.ping?.()
      }
    }, this.heartbeatIntervalMs)

    this.heartbeat.unref()
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

    // HU-13: la sala cambio (salio alguien, se cancelo): el chat revalida el
    // acceso de sus suscriptores. Sin esperar: la notificacion es sincrona y un
    // fallo aqui no debe romper la respuesta HTTP de quien provoco el cambio.
    this.chat.onRoomUpdated(event.roomId).catch((error: unknown) => {
      this.logger.error('chat_actualizacion_de_sala_fallo', {
        roomId: event.roomId,
        reason: error instanceof Error ? error.message : 'error desconocido',
      })
    })
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

    if (CHAT_MESSAGE_TYPES.has(message.type as string)) {
      if (state.subject === null) {
        // Igual que `subscribe`: el chat nunca se atiende sin autenticar antes.
        client.close(CLOSE_UNAUTHENTICATED, 'no_autenticado')
        return
      }

      await this.chat.handle(client, state.subject, message)
      return
    }

    // Tipo de mensaje no reconocido (los comandos de combate --
    // `ready`/`attack`/`useSkill` -- son HU-17/HU-18/HU-19).
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
