import type { Db } from 'mongodb'

/**
 * Esquema del chat de Jugar Online (HU-13, RF-13).
 *
 * Dos colecciones nuevas, aditivas: `battle-rooms` no se toca. El chat NO vive
 * dentro del documento de la sala (contrato de HU-17, seccion 8, guarda ahi la
 * bitacora de batalla): un mensaje por escritura engordaria ese documento sin
 * limite y competiria por su bloqueo optimista con cada accion de la batalla.
 *
 * - `chat-messages`: un documento por mensaje aceptado. `_id` es el
 *   `messageId` (UUID generado por el servidor).
 * - `chat-channels`: contador de `seq` por canal. Es aparte porque la purga por
 *   TTL de los mensajes no debe reiniciar la numeracion (ver
 *   `MongoChatMessageRepository`).
 *
 * Validadores `$jsonSchema` con `additionalProperties: false`, como el resto de
 * colecciones del servicio (docs/architecture.md, «Invariantes»). El limite
 * de longitud del texto que impone el validador (8000) es solo una defensa del
 * motor: el limite real es configurable en la aplicacion (`CHAT_MAX_MESSAGE_LENGTH`,
 * maximo 2000 puntos de codigo, hasta 4 bytes cada uno).
 *
 * Indices:
 * - (`channelKey`, `seq`) UNICO: orden total por canal y ultima defensa contra
 *   un `seq` repetido.
 * - (`senderId`, `commandId`) UNICO: idempotencia (ADR-020, `commandId`).
 * - `expiresAt` con `expireAfterSeconds: 0`: retencion. El instante de caducidad
 *   lo fija cada mensaje al crearse a partir de `CHAT_RETENTION_HOURS`, de modo
 *   que cambiar la retencion no exige tocar el indice.
 *
 * `up` recibe `Db` a proposito: una migracion queda congelada y debe seguir
 * siendo ejecutable tal como se escribio.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('chat-channels', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'seq'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          seq: { bsonType: ['int', 'long'], minimum: 0 },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  await db.createCollection('chat-messages', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'channelKey',
          'seq',
          'senderId',
          'senderDisplayName',
          'commandId',
          'text',
          'sentAt',
          'expiresAt',
        ],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          channelKey: { bsonType: 'string', minLength: 1 },
          seq: { bsonType: ['int', 'long'], minimum: 1 },
          senderId: { bsonType: 'string', minLength: 1 },
          senderDisplayName: { bsonType: 'string', minLength: 1, maxLength: 500 },
          commandId: { bsonType: 'string', minLength: 1, maxLength: 64 },
          text: { bsonType: 'string', minLength: 1, maxLength: 8000 },
          sentAt: { bsonType: 'date' },
          expiresAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const messages = db.collection('chat-messages')

  await messages.createIndex(
    { channelKey: 1, seq: 1 },
    { name: 'channelKey_1_seq_1', unique: true },
  )
  await messages.createIndex(
    { senderId: 1, commandId: 1 },
    { name: 'senderId_1_commandId_1', unique: true },
  )
  await messages.createIndex({ expiresAt: 1 }, { name: 'expiresAt_ttl', expireAfterSeconds: 0 })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('chat-messages').drop()
  await db.collection('chat-channels').drop()
}
