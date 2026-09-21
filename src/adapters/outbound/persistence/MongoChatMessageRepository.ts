import { Int32, MongoServerError, type Collection, type Db } from 'mongodb'

import type { ChatMessage } from '../../../domain/entities/ChatMessage'
import {
  chatChannelFromKey,
  chatChannelKey,
  type ChatChannel,
} from '../../../domain/value-objects/ChatChannel'
import type {
  AppendChatMessageResult,
  ChatHistoryPage,
  ChatHistoryQuery,
  ChatMessageDraft,
  ChatMessageRepositoryPort,
} from '../../../application/ports/ChatMessageRepositoryPort'

export const CHAT_MESSAGES_COLLECTION = 'chat-messages'
export const CHAT_CHANNELS_COLLECTION = 'chat-channels'

export interface ChatMessageDocument {
  readonly _id: string
  readonly channelKey: string
  readonly seq: Int32
  readonly senderId: string
  readonly senderDisplayName: string
  readonly commandId: string
  readonly text: string
  readonly sentAt: Date
  readonly expiresAt: Date
}

/** Contador durable de `seq` por canal. Sobrevive a la purga de mensajes por TTL. */
export interface ChatChannelCounterDocument {
  readonly _id: string
  seq: number
}

/**
 * Intentos de reservar un `seq` ante un choque en el indice unico
 * (`channelKey`, `seq`). Con UNA replica y el cerrojo por canal del gateway no
 * ocurre; existe porque el indice es la ultima defensa si algun dia hay dos
 * escritores, y en ese caso reintentar reserva otro numero.
 */
const MAX_SEQ_ATTEMPTS = 3

/**
 * Repositorio de chat sobre MongoDB (HU-13).
 *
 * `seq` sale de un contador por canal (`findOneAndUpdate` + `$inc`, atomico), y
 * NO de «el maximo de los mensajes + 1»: la purga por TTL puede vaciar un canal
 * tranquilo y el numero volveria a empezar, con clientes que recuerdan un
 * `lastSeq` mayor. El contador vive en su propia coleccion y no expira.
 *
 * Coste de esa eleccion, declarado: si el `insertOne` falla DESPUES de reservar
 * el numero (o dos comandos identicos coinciden), queda un hueco en `seq`. Es
 * inocuo por diseno: `upTo` de `readHistory` le dice al cliente hasta donde
 * esta al dia, y un numero ausente por debajo de `upTo` no existe.
 *
 * No hay transaccion (el nodo de datos no es un replica set): la idempotencia
 * descansa en el indice unico (`senderId`, `commandId`), no en «leer y luego
 * escribir».
 */
export class MongoChatMessageRepository implements ChatMessageRepositoryPort {
  private readonly messages: Collection<ChatMessageDocument>
  private readonly channels: Collection<ChatChannelCounterDocument>

  constructor(db: Db) {
    this.messages = db.collection<ChatMessageDocument>(CHAT_MESSAGES_COLLECTION)
    this.channels = db.collection<ChatChannelCounterDocument>(CHAT_CHANNELS_COLLECTION)
  }

  async append(draft: ChatMessageDraft): Promise<AppendChatMessageResult> {
    const channelKey = chatChannelKey(draft.channel)

    for (let attempt = 1; attempt <= MAX_SEQ_ATTEMPTS; attempt += 1) {
      const counter = await this.channels.findOneAndUpdate(
        { _id: channelKey },
        { $inc: { seq: new Int32(1) } },
        { upsert: true, returnDocument: 'after' },
      )

      if (counter === null) {
        throw new Error('El contador de chat no devolvio documento tras el upsert.')
      }

      const seq = counter.seq

      try {
        await this.messages.insertOne({
          _id: draft.id,
          channelKey,
          seq: new Int32(seq),
          senderId: draft.senderId,
          senderDisplayName: draft.senderDisplayName,
          commandId: draft.commandId,
          text: draft.text,
          sentAt: draft.sentAt,
          expiresAt: draft.expiresAt,
        })

        return {
          message: {
            id: draft.id,
            channel: draft.channel,
            seq,
            senderId: draft.senderId,
            senderDisplayName: draft.senderDisplayName,
            commandId: draft.commandId,
            text: draft.text,
            sentAt: draft.sentAt,
          },
          duplicate: false,
        }
      } catch (error: unknown) {
        if (!(error instanceof MongoServerError) || error.code !== 11000) {
          throw error
        }

        const pattern = error.keyPattern as Record<string, unknown> | undefined

        if (pattern !== undefined && 'commandId' in pattern) {
          const existing = await this.findByCommand(draft.senderId, draft.commandId)

          if (existing !== null) {
            return { message: existing, duplicate: true }
          }
        }

        if (pattern !== undefined && 'seq' in pattern && attempt < MAX_SEQ_ATTEMPTS) {
          continue
        }

        throw error
      }
    }

    throw new Error('No se pudo reservar un seq de chat.')
  }

  async findByCommand(senderId: string, commandId: string): Promise<ChatMessage | null> {
    const document = await this.messages.findOne({ senderId, commandId })

    return document === null ? null : toMessage(document)
  }

  async readHistory(channel: ChatChannel, query: ChatHistoryQuery): Promise<ChatHistoryPage> {
    const channelKey = chatChannelKey(channel)

    const counter = await this.channels.findOne({ _id: channelKey })
    const documents = await this.messages
      .find({
        channelKey,
        seq: { $gt: new Int32(query.afterSeq ?? 0) },
        // El TTL de MongoDB purga con retraso (su monitor corre cada minuto):
        // la lectura no espera a la purga para dejar de ver lo expirado.
        expiresAt: { $gt: query.now },
      })
      .sort({ seq: -1 })
      .limit(query.limit + 1)
      .toArray()

    const truncated = documents.length > query.limit

    return {
      // Se pidio uno de mas, el mas antiguo, solo para saber si habia mas.
      messages: documents.slice(0, query.limit).reverse().map(toMessage),
      upTo: counter?.seq ?? 0,
      truncated,
    }
  }
}

const toMessage = (document: ChatMessageDocument): ChatMessage => ({
  id: document._id,
  channel: chatChannelFromKey(document.channelKey),
  // El controlador promueve `Int32` a `number` al leer.
  seq: Number(document.seq),
  senderId: document.senderId,
  senderDisplayName: document.senderDisplayName,
  commandId: document.commandId,
  text: document.text,
  sentAt: document.sentAt,
})
