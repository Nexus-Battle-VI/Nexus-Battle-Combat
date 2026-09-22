import type { Db } from 'mongodb'

/**
 * Coleccion nueva del `RewardWorkflow` de HU-22 (`hu-22-reward-contract-v1`
 * §8), Task HU-22.3.
 *
 * ADITIVA: `battle-rooms` no se toca. El workflow de recompensa no vive
 * dentro del documento de la sala por el mismo motivo que el chat de HU-13
 * (migracion 006): una escritura por transicion competiria por el bloqueo
 * optimista de la sala con cada accion de la batalla, y la sala ya esta
 * `FINISHED` (inmutable) cuando el workflow empieza a avanzar.
 *
 * `_id` es determinista: `${battleId}:${playerId}` (no un UUID aleatorio).
 * Es, por construccion, la clave de idempotencia de "un workflow por
 * participante por batalla": un segundo intento de crearlo (notificacion
 * repetida de HU-21, semantica "al menos una vez") encuentra el mismo `_id`
 * y no duplica nada.
 *
 * Indice en `state`: el barrido (`IntervalRewardWorkflowScheduler`) consulta
 * "workflows no terminales" en cada tick.
 *
 * Validador `$jsonSchema` con `additionalProperties: false`, como el resto
 * de colecciones del servicio.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('reward-workflows', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'battleId',
          'playerId',
          'teamLabel',
          'seat',
          'creditsAmount',
          'victoryCreditsAmount',
          'finishedAt',
          'state',
          'walletOperationId',
          'balance',
          'victoryProgress',
          'weeklyChestCount',
          'chestEarned',
          'rewardProductId',
          'rewardSku',
          'rewardName',
          'inventoryOperationId',
          'failureReason',
          'attempts',
          'createdAt',
          'updatedAt',
        ],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', minLength: 1 },
          battleId: { bsonType: 'string', minLength: 1 },
          playerId: { bsonType: 'string', minLength: 1 },
          teamLabel: { bsonType: 'string', minLength: 1 },
          seat: { bsonType: 'number', minimum: 0 },
          creditsAmount: { bsonType: 'number', minimum: 1 },
          victoryCreditsAmount: { bsonType: 'number', minimum: 0 },
          finishedAt: { bsonType: 'date' },
          state: {
            enum: [
              'PENDING_CREDIT',
              'CREDIT_CONFIRMED',
              'CHEST_ELIGIBLE',
              'REWARD_SELECTED',
              'COMPLETED',
              'TERMINAL_FAILURE',
            ],
          },
          walletOperationId: { bsonType: 'string', minLength: 1 },
          balance: { bsonType: ['number', 'null'], minimum: 0 },
          victoryProgress: { bsonType: ['number', 'null'], minimum: 0 },
          weeklyChestCount: { bsonType: ['number', 'null'], minimum: 0 },
          chestEarned: { bsonType: ['bool', 'null'] },
          rewardProductId: { bsonType: ['string', 'null'], minLength: 1 },
          rewardSku: { bsonType: ['string', 'null'], minLength: 1 },
          rewardName: { bsonType: ['string', 'null'], minLength: 1 },
          inventoryOperationId: { bsonType: ['string', 'null'], minLength: 1 },
          failureReason: { bsonType: ['string', 'null'] },
          attempts: { bsonType: 'number', minimum: 0 },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const workflows = db.collection('reward-workflows')

  await workflows.createIndex({ state: 1 }, { name: 'state_1' })
  await workflows.createIndex({ battleId: 1, playerId: 1 }, { name: 'battleId_1_playerId_1' })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('reward-workflows').drop()
}
