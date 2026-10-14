import type { Db } from 'mongodb'

type Schema = Record<string, unknown>
const record = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Amplía únicamente los metadatos de torneo y conserva todas las reglas vigentes. */
export const up = async (db: Db): Promise<void> => {
  const [info] = await db.listCollections({ name: 'battle-rooms' }).toArray()
  const options = (info as { options?: Schema } | undefined)?.options
  const validator: unknown = options?.validator
  const schema = record(validator) ? validator.$jsonSchema : undefined
  const properties = record(schema) ? schema.properties : undefined
  const tournament = record(properties) ? properties.tournament : undefined
  const tournamentProperties = record(tournament) ? tournament.properties : undefined
  if (
    !record(validator) ||
    !record(schema) ||
    !record(properties) ||
    !record(tournament) ||
    !record(tournamentProperties)
  )
    throw new Error('Falta el esquema de salas de torneo; no se modifica la colección.')
  await db.command({
    collMod: 'battle-rooms',
    validator: {
      ...validator,
      $jsonSchema: {
        ...schema,
        properties: {
          ...properties,
          tournament: {
            ...tournament,
            properties: { ...tournamentProperties, isTest: { bsonType: 'bool' } },
          },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
