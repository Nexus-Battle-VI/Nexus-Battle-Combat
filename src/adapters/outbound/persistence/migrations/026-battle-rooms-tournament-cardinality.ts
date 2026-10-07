import type { Db } from 'mongodb'

type Schema = Record<string, unknown>
const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Amplia 018 sin reescribirla, sin backfill y sin recalcular hashes historicos. */
export const up = async (db: Db): Promise<void> => {
  const [info] = await db.listCollections({ name: 'battle-rooms' }).toArray()
  const options = (info as { options?: Schema } | undefined)?.options
  const validator = options?.validator
  const schema = isRecord(validator) ? validator.$jsonSchema : undefined
  const properties = isRecord(schema) ? schema.properties : undefined
  const tournament = isRecord(properties) ? properties.tournament : undefined
  const tournamentProperties = isRecord(tournament) ? tournament.properties : undefined
  if (
    !isRecord(schema) ||
    !isRecord(properties) ||
    !isRecord(tournament) ||
    !isRecord(tournamentProperties)
  ) {
    throw new Error('battle-rooms necesita el esquema de torneo de la migracion 018.')
  }

  const newFields = ['mode', 'teamSize', 'contractVersion', 'requestHashVersion']
  const variants = (['SOLO', 'DUO', 'TRIO'] as const).map((mode, index) => ({
    bsonType: 'object',
    required: ['mode', 'teamSize', 'contractVersion'],
    properties: { mode: { enum: [mode] }, teamSize: { enum: [index + 1] } },
  }))
  await db.command({
    collMod: 'battle-rooms',
    validator: {
      $jsonSchema: {
        ...schema,
        properties: {
          ...properties,
          tournament: {
            ...tournament,
            properties: {
              ...tournamentProperties,
              mode: { enum: ['SOLO', 'DUO', 'TRIO'] },
              teamSize: { bsonType: ['int', 'long', 'double'], enum: [1, 2, 3] },
              contractVersion: { enum: [3] },
              requestHashVersion: { enum: [2] },
            },
            oneOf: [
              { bsonType: 'null' },
              {
                bsonType: 'object',
                not: { anyOf: newFields.map((field) => ({ required: [field] })) },
              },
              ...variants,
            ],
          },
        },
      },
      $expr: {
        $cond: [
          { $in: ['$tournament.mode', ['SOLO', 'DUO', 'TRIO']] },
          {
            $and: [
              { $eq: ['$mode', 'PVP'] },
              { $eq: ['$reward.amount', 0] },
              {
                $ne: [{ $arrayElemAt: ['$teams.label', 0] }, { $arrayElemAt: ['$teams.label', 1] }],
              },
              {
                $eq: [
                  {
                    $size: {
                      $setUnion: [
                        {
                          $reduce: {
                            input: '$teams',
                            initialValue: [],
                            in: { $concatArrays: ['$$value', '$$this.participants.playerId'] },
                          },
                        },
                        [],
                      ],
                    },
                  },
                  { $multiply: [2, '$tournament.teamSize'] },
                ],
              },
              {
                $allElementsTrue: [
                  {
                    $map: {
                      input: '$teams',
                      as: 'team',
                      in: {
                        $and: [
                          { $eq: ['$$team.capacity', '$tournament.teamSize'] },
                          { $eq: [{ $size: '$$team.participants' }, '$tournament.teamSize'] },
                          {
                            $allElementsTrue: [
                              {
                                $map: {
                                  input: '$$team.participants',
                                  as: 'member',
                                  in: {
                                    $and: [
                                      { $eq: ['$$member.kind', 'HUMAN'] },
                                      { $eq: [{ $type: '$$member.stake' }, 'missing'] },
                                    ],
                                  },
                                },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
          true,
        ],
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
