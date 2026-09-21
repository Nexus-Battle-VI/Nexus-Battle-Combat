import { Inject, Optional } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets'

import { toBattleEventWire } from '../../../application/dto/BattleEventDto'
import {
  RoomAccessForbiddenError,
  RoomNotFoundError,
} from '../../../application/errors/ApplicationError'
import type { BattleEventPublisherPort } from '../../../application/ports/BattleEventPublisherPort'
import {
  BATTLE_ROOM_REPOSITORY,
  type BattleRoomRepositoryPort,
} from '../../../application/ports/BattleRoomRepositoryPort'
import type {
  BattleRoomUpdatedEvent,
  RealtimeNotifierPort,
} from '../../../application/ports/RealtimeNotifierPort'
import type { ResumeBattle } from '../../../application/use-cases/ResumeBattle'
import type { ConsumeRealtimeTicket } from '../../../application/use-cases/RealtimeTickets'
import type { BattleEvent } from '../../../domain/entities/BattleEvent'
import type { Logger } from '../../../infrastructure/observability/logger'
import { LOGGER } from '../../../infrastructure/observability/logger-token'
import { CONSUME_REALTIME_TICKET, RESUME_BATTLE } from '../http/tokens'
import { CHAT_MESSAGE_TYPES, ChatRealtimeHandler } from './ChatRealtimeHandler'
import type { RealtimeSocket, RealtimeSocketData } from './RealtimeSocket'
import { SerialQueue } from './SerialQueue'

export type { RealtimeSocket, RealtimeSocketData } from './RealtimeSocket'

/**
 * Gateway WebSocket de Combat (RF-15 y RF-17, ADR-020 de
 * Nexus-Battle-Infrastructure -- Accepted: WebSocket NATIVO,
 * `@nestjs/websockets` + `@nestjs/platform-ws`, nunca Socket.IO).
 *
 * PROTOCOLO (contrato HU-17 v1):
 *
 *  - AUTENTICACION por ticket de un solo uso (ADR-020): el cliente lo pide por
 *    HTTP (`POST /v1/combat/realtime/tickets`) y lo envia como PRIMER mensaje
 *    `{"type":"auth","ticket":"..."}`. Sin ticket valido en 5 s, o con uno
 *    usado, caducado o desconocido, se cierra con `4401`. El `sub` del ticket
 *    es la unica identidad de la conexion: ningun mensaje posterior puede
 *    declarar otro jugador. El JWT NUNCA viaja por el socket ni en la URL.
 *  - `{"type":"subscribe","roomId"}`: lobby (`battle-room.updated`), sin
 *    cambios respecto a HU-15.2.
 *  - `{"type":"resume","roomId","lastSeq"?}`: SOLO participantes. Se suscribe a
 *    los eventos de batalla y recupera el estado: reenvio ordenado de los
 *    eventos posteriores a `lastSeq` o `snapshot` completo, y `resume.ok`.
 *    RECUPERACION SIN PERDIDA: la conexion pasa a "recuperando" ANTES de leer el
 *    estado y retiene los eventos que se publiquen mientras tanto; despues entrega
 *    (en un unico bloque sincrono) lectura, retenidos con `seq` posterior y
 *    suscripcion, y por ultimo `resume.ok` con el ultimo `seq` realmente entregado.
 *  - Difusion de eventos de batalla con `seq` (`battleStarted`,
 *    `turnAdvanced`): SOLO a las conexiones de participantes de esa sala, y
 *    SIEMPRE despues de que el caso de uso persistio (este gateway solo recibe
 *    eventos ya persistidos por `BattleEventPublisherPort`).
 *  - LATIDO: ping cada 25 s; una conexion que no responde con pong se cierra.
 *  - Mensajes de hasta 16 KiB (`maxPayload`); mayores cierran la conexion.
 *  - CHAT (HU-13, RF-13): `chat.subscribe`, `chat.send` y `chat.unsubscribe`
 *    se delegan en `ChatRealtimeHandler`. Van por ESTA ruta y por la misma
 *    identidad (el `sub` del ticket); el chat tiene su propio `seq` por canal,
 *    independiente del de los eventos de batalla. Los comandos de chat de una
 *    conexion se atienden EN ORDEN de llegada (ver `handleChat`). Contrato:
 *    `docs/contracts/hu-13-chat-v1.md` de Nexus-Battle-Infrastructure.
 *
 * Un comando rechazado responde SOLO a quien lo envio con `command.rejected` y
 * un codigo estable, sin modificar nada. Nunca viajan semilla, estado del
 * generador ni valores aleatorios futuros.
 */
/** Cierre por falta de autenticacion o ticket invalido (ADR-020, seccion "Autenticacion"). */
const CLOSE_UNAUTHENTICATED = 4401
/** Cierre por un mensaje que no es JSON valido o no declara un `type` reconocido. */
const CLOSE_BAD_MESSAGE = 4400
/** Segundos que ADR-020 concede para autenticarse tras conectar. */
export const AUTH_TIMEOUT_MS = 5_000
/** Latido del servidor (ADR-020): cada 25 segundos. */
export const HEARTBEAT_INTERVAL_MS = 25_000
/** Tamano maximo de un mensaje entrante (ADR-020): 16 KiB. */
export const MAX_MESSAGE_BYTES = 16 * 1024
/** Cierre por exceso de comandos de chat en espera: RFC 6455, 1008 (violacion de politica). */
const CLOSE_POLICY_VIOLATION = 1008
/**
 * Comandos de chat de una conexion en espera de su turno. Decision tecnica: acota
 * la memoria que un cliente puede ocupar enviando mas rapido de lo que se atiende.
 * ADR-020 pide un limite de comandos por conexion «configurable»; este es el
 * limite de comandos EN COLA, no la frecuencia (esa la limita el chat por
 * remitente y canal).
 */
const MAX_PENDING_CHAT_COMMANDS = 64

const OPEN_STATE = 1

export interface RealtimeGatewayOptions {
  readonly authTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
}

/** Token opcional: sin proveedor se usan los valores de ADR-020 (5 s de autenticacion, latido de 25 s). */
export const REALTIME_GATEWAY_OPTIONS = Symbol('RealtimeGatewayOptions')

/**
 * Ventana de recuperacion de un `resume` en curso: eventos YA PERSISTIDOS y
 * publicados mientras el estado aun se esta leyendo. Se retienen (no se envian ni
 * se pierden) hasta que la recuperacion se entrega en orden.
 */
interface PendingResume {
  readonly roomId: string
  readonly buffered: { readonly seq: number; readonly payload: string }[]
}

interface ConnectionState {
  subject: string | null
  /** Sala del lobby a la que esta suscrita (`battle-room.updated`). */
  roomId: string | null
  /** Sala de batalla de la que es PARTICIPANTE y de la que recibe eventos con `seq`. */
  battleRoomId: string | null
  /** `resume` en curso: mientras exista, los eventos de su sala se retienen aqui. */
  pendingResume: PendingResume | null
  /** Serializa los `resume` de una misma conexion: una recuperacion no se intercala con otra. */
  resumeChain: Promise<void>
  /** Comandos de chat de esta conexion, atendidos de uno en uno y en orden de llegada (HU-13). */
  readonly chatQueue: SerialQueue
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeat: ReturnType<typeof setInterval> | null
  alive: boolean
}

@WebSocketGateway({
  // Literal, no derivado de `AppConfig.globalPrefix`: la metadata del
  // decorador es estatica (se evalua al cargar la clase, antes de que exista
  // el contenedor de DI). Coincide con el valor por defecto de
  // `GLOBAL_PREFIX` ('api') y con la ruta exacta de ADR-020.
  path: '/api/v1/combat/realtime',
  maxPayload: MAX_MESSAGE_BYTES,
})
export class BattleRoomRealtimeGateway
  implements
    OnGatewayConnection<RealtimeSocket>,
    OnGatewayDisconnect<RealtimeSocket>,
    RealtimeNotifierPort,
    BattleEventPublisherPort
{
  @WebSocketServer()
  server: unknown

  private readonly connections = new Map<RealtimeSocket, ConnectionState>()
  private readonly authTimeoutMs: number
  private readonly heartbeatIntervalMs: number

  constructor(
    @Inject(CONSUME_REALTIME_TICKET) private readonly consumeTicket: ConsumeRealtimeTicket,
    @Inject(BATTLE_ROOM_REPOSITORY) private readonly rooms: BattleRoomRepositoryPort,
    @Inject(RESUME_BATTLE) private readonly resumeBattle: ResumeBattle,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ChatRealtimeHandler) private readonly chat: ChatRealtimeHandler,
    @Optional() @Inject(REALTIME_GATEWAY_OPTIONS) options: RealtimeGatewayOptions = {},
  ) {
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  }

  handleConnection(client: RealtimeSocket): void {
    const state: ConnectionState = {
      subject: null,
      roomId: null,
      battleRoomId: null,
      pendingResume: null,
      resumeChain: Promise.resolve(),
      chatQueue: new SerialQueue(MAX_PENDING_CHAT_COMMANDS, (error: unknown) => {
        this.logger.error('realtime_chat_fallo', {
          reason: error instanceof Error ? error.name : 'desconocido',
        })
      }),
      authTimer: setTimeout(() => {
        // Sin `{"type":"auth","ticket"}` valido en la ventana de ADR-020: se
        // cierra con el codigo que declara la seccion "Autenticacion".
        client.close(CLOSE_UNAUTHENTICATED, 'auth_timeout')
      }, this.authTimeoutMs),
      heartbeat: null,
      alive: true,
    }

    state.heartbeat = setInterval(() => {
      if (!state.alive) {
        // Sin pong desde el ultimo ping: conexion muerta. Queda desconectada,
        // NO abandonada (el abandono es regla de producto de HU-21).
        this.logger.info('realtime_heartbeat_timeout', {})
        if (client.terminate !== undefined) {
          client.terminate()
        } else {
          client.close(1001, 'heartbeat_timeout')
        }
        return
      }

      state.alive = false
      client.ping?.()
    }, this.heartbeatIntervalMs)
    state.heartbeat.unref()
    state.authTimer?.unref()

    this.connections.set(client, state)

    client.on('message', (data: RealtimeSocketData) => {
      void this.handleMessage(client, state, data)
    })
    client.on('pong', () => {
      state.alive = true
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

    if (state?.heartbeat !== null && state?.heartbeat !== undefined) {
      clearInterval(state.heartbeat)
    }

    // Limpieza explicita: sin esto, una conexion cerrada seguiria "suscrita"
    // en el mapa y cada evento futuro de su sala intentaria escribir en un
    // socket muerto.
    this.connections.delete(client)
    this.chat.onDisconnect(client)
  }

  /**
   * Puerto de salida (`RealtimeNotifierPort`): difunde SOLO a las conexiones
   * autenticadas y suscritas al lobby de `event.roomId` (aislamiento entre
   * salas). Payload minimo: `roomId`, `status`, `version` -- nada mas.
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
        reason: error instanceof Error ? error.name : 'desconocido',
      })
    })
  }

  /**
   * Puerto `BattleEventPublisherPort` (HU-17): difunde eventos con `seq` YA
   * PERSISTIDOS a los participantes de la sala que hicieron `resume`. El
   * mensaje se serializa UNA vez: todos los clientes reciben exactamente los
   * mismos bytes (misma cola, mismo `seq`).
   *
   * Una conexion con un `resume` EN CURSO para esa sala no recibe el evento en
   * caliente: se retiene y se entrega despues de la recuperacion, en orden. Sin
   * esto, un evento publicado entre la lectura del estado y la suscripcion se
   * perderia para ese socket mientras `resume.ok` le diria que esta al dia.
   */
  publish(roomId: string, events: readonly BattleEvent[]): void {
    const wire = events.map((event) => ({
      seq: event.seq,
      payload: JSON.stringify(toBattleEventWire(roomId, event)),
    }))

    for (const [client, state] of this.connections) {
      if (client.readyState !== OPEN_STATE) {
        continue
      }

      if (state.pendingResume?.roomId === roomId) {
        state.pendingResume.buffered.push(...wire)
      } else if (state.battleRoomId === roomId) {
        for (const { payload } of wire) {
          client.send(payload)
        }
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
      this.handleAuth(client, state, message)
      return
    }

    if (message.type === 'subscribe') {
      await this.handleSubscribe(client, state, message)
      return
    }

    if (message.type === 'resume') {
      // Serializado por conexion: dos `resume` no comparten ventana de recuperacion.
      const run = state.resumeChain.then(() => this.handleResume(client, state, message))

      state.resumeChain = run
      await run
      return
    }

    if (CHAT_MESSAGE_TYPES.has(message.type as string)) {
      this.handleChat(client, state, message)
      return
    }

    // Tipo de mensaje no reconocido en este protocolo (los comandos de combate
    // -- `attack`/`useSkill` -- son HU-18/HU-19).
    client.close(CLOSE_BAD_MESSAGE, 'tipo_no_reconocido')
  }

  /**
   * Comandos de chat (HU-13, RF-13). Se atienden de uno en uno y en el orden en
   * que llegaron: un cliente que envia `chat.subscribe` y `chat.send` seguidos
   * espera que el segundo vea la suscripcion del primero, y `chat.subscribe` es
   * asincrono (lee la sala). Sin la cola, `chat.send` se comprobaria antes de que
   * la suscripcion existiera y se rechazaria con `NOT_SUBSCRIBED`.
   *
   * La cola es SOLO de chat: `auth`, `subscribe` y `resume` conservan el
   * comportamiento de HU-17, incluida la ventana de recuperacion del `resume`.
   */
  private handleChat(
    client: RealtimeSocket,
    state: ConnectionState,
    message: Record<string, unknown>,
  ): void {
    // El `sub` se toma AQUI, en el orden de llegada: un `auth` anterior ya lo fijo
    // (consumir el ticket es sincrono) y no puede cambiar despues.
    const subject = state.subject

    if (subject === null) {
      // Igual que `subscribe` y `resume`: el chat nunca se atiende sin autenticar antes.
      client.close(CLOSE_UNAUTHENTICATED, 'no_autenticado')
      return
    }

    const accepted = state.chatQueue.push(() => this.chat.handle(client, subject, message))

    if (!accepted) {
      client.close(CLOSE_POLICY_VIOLATION, 'demasiados_mensajes')
    }
  }

  private handleAuth(
    client: RealtimeSocket,
    state: ConnectionState,
    message: Record<string, unknown>,
  ): void {
    if (state.subject !== null) {
      // Una conexion ya autenticada no puede cambiar de identidad.
      sendJson(client, { type: 'command.rejected', code: 'ALREADY_AUTHENTICATED' })
      return
    }

    // El ticket se CONSUME siempre (un solo uso); un motivo de rechazo no se
    // distingue del resto: ni usado, ni caducado, ni desconocido.
    const subject = this.consumeTicket.execute(message.ticket)

    if (subject === null) {
      this.logger.warn('realtime_auth_rechazada', { reason: 'ticket_invalido' })
      client.close(CLOSE_UNAUTHENTICATED, 'ticket_invalido')
      return
    }

    if (state.authTimer !== null) {
      clearTimeout(state.authTimer)
      state.authTimer = null
    }
    state.subject = subject

    sendJson(client, { type: 'auth.ok' })
  }

  private async handleSubscribe(
    client: RealtimeSocket,
    state: ConnectionState,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (state.subject === null) {
      // Nunca se acepta una suscripcion sin autenticar primero: el `sub` del
      // ticket es la unica identidad de la conexion (ADR-020).
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
    sendJson(client, { type: 'subscribe.ok', roomId })
  }

  private async handleResume(
    client: RealtimeSocket,
    state: ConnectionState,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (state.subject === null) {
      client.close(CLOSE_UNAUTHENTICATED, 'no_autenticado')
      return
    }

    const roomId = message.roomId

    if (typeof roomId !== 'string' || roomId.length === 0) {
      client.close(CLOSE_BAD_MESSAGE, 'roomId_invalido')
      return
    }

    // La ventana se abre ANTES de leer el estado: todo evento que se persista y
    // publique desde este punto queda retenido y no puede perderse. Un no
    // participante nunca recibe nada: si el caso de uso falla, la ventana se
    // descarta sin enviarse.
    const pending: PendingResume = { roomId, buffered: [] }

    state.pendingResume = pending

    try {
      const result = await this.resumeBattle.execute(roomId, state.subject, message.lastSeq)

      // Desde aqui TODO es sincrono: ningun `publish` puede intercalarse entre la
      // entrega de la recuperacion, la del bufer y la suscripcion.
      let delivered = result.seq

      if (result.kind === 'replay') {
        for (const event of result.events) {
          sendJson(client, toBattleEventWire(roomId, event))
        }
      } else {
        sendJson(client, result.snapshot)
      }

      // Lo retenido: se descarta lo que la lectura ya incluia (`seq` <= leido) y
      // se entrega en orden estricto. Ante un hueco (no deberia ocurrir con un
      // unico proceso) se detiene: el cliente lo detecta por `seq` y pide otro
      // `resume`, nunca se le presenta un estado inventado.
      for (const entry of pending.buffered) {
        if (entry.seq <= delivered) {
          continue
        }

        if (entry.seq !== delivered + 1) {
          break
        }

        if (client.readyState === OPEN_STATE) {
          client.send(entry.payload)
        }
        delivered = entry.seq
      }

      state.roomId = roomId
      state.battleRoomId = roomId
      sendJson(client, { type: 'resume.ok', roomId, seq: delivered })
    } catch (error: unknown) {
      if (error instanceof RoomAccessForbiddenError) {
        sendJson(client, { type: 'command.rejected', code: 'NOT_A_PARTICIPANT' })
        return
      }

      if (error instanceof RoomNotFoundError) {
        sendJson(client, { type: 'command.rejected', code: 'ROOM_NOT_FOUND' })
        return
      }

      this.logger.error('realtime_resume_fallo', {
        roomId,
        error: error instanceof Error ? error.name : 'desconocido',
      })
      sendJson(client, { type: 'command.rejected', code: 'INTERNAL_ERROR' })
    } finally {
      if (state.pendingResume === pending) {
        state.pendingResume = null
      }
    }
  }
}

const sendJson = (client: RealtimeSocket, payload: object): void => {
  if (client.readyState === OPEN_STATE) {
    client.send(JSON.stringify(payload))
  }
}

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
