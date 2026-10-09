import { Int32, type Db } from 'mongodb'

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const widenArtifactTypes = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(widenArtifactTypes)
  if (!isRecord(node)) return node
  const copy: Schema = {}
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'enum' &&
      Array.isArray(value) &&
      value.length === 2 &&
      value.includes('ONNX_MODEL') &&
      value.includes('PARITY_REFERENCE')
    ) {
      copy[key] = ['ONNX_MODEL', 'PARITY_REFERENCE', 'EVALUATION_SUMMARY']
    } else {
      copy[key] = widenArtifactTypes(value)
    }
  }
  return copy
}

const collMod = async (db: Db, name: string, validator: unknown): Promise<void> => {
  await db.command({
    collMod: name,
    validator,
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

/**
 * EN-037.3 review hardening:
 * - un unico documento `active` es la autoridad atomica/CAS del runtime;
 * - los estados de `ai-model-versions` quedan como historial reconciliable;
 * - summaries completos de evaluacion se conservan content-addressed.
 */
export const up = async (db: Db): Promise<void> => {
  const existingReference = await db
    .listCollections({ name: 'ai-model-active-reference' })
    .hasNext()
  if (!existingReference) {
    await db.createCollection('ai-model-active-reference', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['_id', 'modelVersion', 'modelRevision', 'generation', 'updatedAt'],
          properties: {
            _id: { bsonType: 'string', enum: ['active'] },
            modelVersion: { bsonType: 'string', minLength: 1 },
            modelRevision: { bsonType: ['int', 'long'], minimum: 0 },
            generation: { bsonType: ['int', 'long'], minimum: 1 },
            updatedAt: { bsonType: 'date' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    })
  }

  const versions = db.collection<{
    _id: string
    state: string
    revision: Int32
    updatedAt: Date
  }>('ai-model-versions')
  const historicalActive = await versions.findOne({ state: 'ACTIVE' })
  if (historicalActive !== null) {
    await db.collection<{ _id: string }>('ai-model-active-reference').updateOne(
      { _id: 'active' },
      {
        $setOnInsert: {
          modelVersion: historicalActive._id,
          modelRevision: historicalActive.revision,
          generation: new Int32(1),
          updatedAt: historicalActive.updatedAt,
        },
      },
      { upsert: true },
    )
  }
  await versions.dropIndex('active_unique').catch((error: unknown) => {
    if (!isRecord(error) || error.codeName !== 'IndexNotFound') throw error
  })

  const artifactsInfo = await db.listCollections({ name: 'ai-model-artifacts' }).next()
  const artifactsValidator = (artifactsInfo as { options?: Schema } | null)?.options?.validator
  if (artifactsValidator !== undefined) {
    await collMod(db, 'ai-model-artifacts', widenArtifactTypes(artifactsValidator))
  }

  const evaluations = db.collection('ai-model-evaluations')
  await evaluations.updateMany({}, [
    {
      $set: {
        previousActiveRevision: { $ifNull: ['$previousActiveRevision', null] },
        evaluationProtocolSha256: { $ifNull: ['$evaluationProtocolSha256', null] },
        candidateSummarySha256: { $ifNull: ['$candidateSummarySha256', null] },
        activeBaselineSummarySha256: { $ifNull: ['$activeBaselineSummarySha256', null] },
      },
    },
  ])

  const evaluationsInfo = await db.listCollections({ name: 'ai-model-evaluations' }).next()
  const validator = (evaluationsInfo as { options?: Schema } | null)?.options?.validator
  if (!isRecord(validator) || !isRecord(validator.$jsonSchema)) {
    throw new Error('ai-model-evaluations no tiene $jsonSchema para ampliar.')
  }
  const jsonSchema = validator.$jsonSchema
  const required = Array.isArray(jsonSchema.required)
    ? jsonSchema.required.filter((value): value is string => typeof value === 'string')
    : []
  const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {}
  const nullableSha = {
    oneOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9a-f]{64}$' }],
  }
  await collMod(db, 'ai-model-evaluations', {
    ...validator,
    $jsonSchema: {
      ...jsonSchema,
      required: [
        ...required,
        'previousActiveRevision',
        'evaluationProtocolSha256',
        'candidateSummarySha256',
        'activeBaselineSummarySha256',
      ],
      properties: {
        ...properties,
        previousActiveRevision: {
          oneOf: [{ bsonType: 'null' }, { bsonType: ['int', 'long'], minimum: 0 }],
        },
        evaluationProtocolSha256: nullableSha,
        candidateSummarySha256: nullableSha,
        activeBaselineSummarySha256: nullableSha,
      },
    },
  })
}
