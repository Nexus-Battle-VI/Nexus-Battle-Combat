import type { Db } from 'mongodb'

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const withoutKey = (schema: Schema, key: string): Schema => {
  const copy = { ...schema }
  Reflect.deleteProperty(copy, key)

  return copy
}

/**
 * `023` (ya en `develop`) fija un validador estricto para `COMBAT_DECISION` que
 * exige `legalActions` con al menos una candidata y `decisionSource` humano o
 * de política entrenable. `CombatDecisionRecorder` (HU-93.2) necesita además
 * registrar el cierre técnico `END_TURN`: Combat lo emite exclusivamente cuando
 * `legalActions = []`, con `decisionSource: 'SYSTEM'` y `schemaVersion: 2`
 * (`COMBAT_END_TURN_DECISION_EVENT_SCHEMA_VERSION` en
 * `src/domain/decision/CombatDecisionEvent.ts`).
 *
 * Esta migración AMPLÍA el validador vigente (nunca lo reemplaza por uno
 * inventado): toma el `$jsonSchema` real de la colección y
 *
 * 1. amplía `properties.schemaVersion.enum` de `[1]` a `[1, 2]`;
 * 2. amplía `properties.decisionSource.enum` añadiendo `'SYSTEM'`;
 * 3. quita el `minItems: 1` global de `properties.legalActions` (la longitud
 *    exigida pasa a depender de la rama, ver 4);
 * 4. añade `END_TURN` al `oneOf` de `properties.selectedAction`;
 * 5. en la rama `COMBAT_DECISION` ya existente (`oneOf[0]`), FIJA de vuelta las
 *    restricciones que antes eran globales — `schemaVersion: [1]`,
 *    `decisionSource` sin `SYSTEM`, `legalActions.minItems: 1` y
 *    `selectedAction` sin `END_TURN` — de modo que un documento v1 sigue
 *    exigiendo exactamente lo mismo que antes;
 * 6. añade una rama nueva `COMBAT_DECISION` para `schemaVersion: 2` que exige
 *    `decisionSource: 'SYSTEM'`, `legalActions` vacío (`maxItems: 0`) y
 *    `selectedAction = { kind: 'END_TURN' }` exclusivamente.
 *
 * La rama `COMBAT_DECISION_OUTCOME` no se toca.
 *
 * Es idempotente: si `schemaVersion.enum` ya incluye `2`, no hace nada.
 */
export const up = async (db: Db): Promise<void> => {
  const [info] = await db.listCollections({ name: 'combat-decision-events' }).toArray()
  const options = (info as { options?: Schema } | undefined)?.options
  const validator = options?.validator

  if (!isRecord(validator) || !isRecord(validator.$jsonSchema)) {
    throw new Error('combat-decision-events no tiene un validador $jsonSchema que ampliar.')
  }
  const root: Schema = validator.$jsonSchema

  if (!isRecord(root.properties)) {
    throw new Error('El $jsonSchema de combat-decision-events no tiene properties.')
  }
  const properties: Schema = root.properties

  if (!Array.isArray(root.oneOf)) {
    throw new Error('El $jsonSchema de combat-decision-events no tiene oneOf.')
  }
  const branches: readonly unknown[] = root.oneOf

  if (!isRecord(properties.schemaVersion)) {
    throw new Error('properties.schemaVersion no es un objeto de esquema.')
  }
  const schemaVersionProperty: Schema = properties.schemaVersion

  if (deepEqual(schemaVersionProperty.enum, [1, 2])) {
    // Idempotente: ya ampliado.
    return
  }
  if (!deepEqual(schemaVersionProperty.enum, [1])) {
    throw new Error('properties.schemaVersion.enum no es el [1] esperado antes de ampliar.')
  }

  if (!isRecord(properties.decisionSource)) {
    throw new Error('properties.decisionSource no es un objeto de esquema.')
  }
  const decisionSourceProperty: Schema = properties.decisionSource
  const previousDecisionSources = ['HUMAN', 'RULE_BASED', 'RANDOM', 'MCTS', 'NEURAL']
  if (!deepEqual(decisionSourceProperty.enum, previousDecisionSources)) {
    throw new Error('properties.decisionSource.enum no es el esperado antes de ampliar.')
  }

  if (!isRecord(properties.legalActions) || properties.legalActions.minItems !== 1) {
    throw new Error(
      'properties.legalActions no tiene el minItems global esperado antes de ampliar.',
    )
  }
  const legalActionsProperty: Schema = properties.legalActions
  const legalActionsWithoutGlobalMinItems = withoutKey(legalActionsProperty, 'minItems')

  if (!isRecord(properties.selectedAction) || !Array.isArray(properties.selectedAction.oneOf)) {
    throw new Error('properties.selectedAction no tiene el oneOf esperado antes de ampliar.')
  }
  const selectedActionProperty: Schema = properties.selectedAction
  const originalSelectedActionOneOf: readonly unknown[] = properties.selectedAction.oneOf

  const endTurnSchema: Schema = {
    bsonType: 'object',
    required: ['kind'],
    additionalProperties: false,
    properties: { kind: { enum: ['END_TURN'] } },
  }

  const decisionBranchIndex = branches.findIndex(
    (branch) =>
      isRecord(branch) &&
      isRecord(branch.properties) &&
      isRecord(branch.properties.eventType) &&
      deepEqual(branch.properties.eventType.enum, ['COMBAT_DECISION']),
  )
  if (decisionBranchIndex === -1) {
    throw new Error('No se encontró la rama COMBAT_DECISION dentro de oneOf.')
  }
  const decisionBranch = branches[decisionBranchIndex]
  if (!isRecord(decisionBranch)) {
    throw new Error('La rama COMBAT_DECISION encontrada no es un objeto de esquema.')
  }
  const decisionBranchProperties = isRecord(decisionBranch.properties)
    ? decisionBranch.properties
    : {}

  const v1DecisionBranch: Schema = {
    ...decisionBranch,
    properties: {
      ...decisionBranchProperties,
      schemaVersion: { enum: [1] },
      decisionSource: { enum: previousDecisionSources },
      legalActions: { ...legalActionsWithoutGlobalMinItems, minItems: 1 },
      selectedAction: { oneOf: originalSelectedActionOneOf },
    },
  }

  const endTurnDecisionBranch: Schema = {
    ...decisionBranch,
    properties: {
      ...decisionBranchProperties,
      schemaVersion: { enum: [2] },
      decisionSource: { enum: ['SYSTEM'] },
      legalActions: { ...legalActionsWithoutGlobalMinItems, maxItems: 0 },
      selectedAction: endTurnSchema,
    },
  }

  const widenedBranches: unknown[] = branches.slice()
  widenedBranches.splice(decisionBranchIndex, 1, v1DecisionBranch, endTurnDecisionBranch)

  const widenedRoot: Schema = {
    ...root,
    properties: {
      ...properties,
      schemaVersion: { ...schemaVersionProperty, enum: [1, 2] },
      decisionSource: { ...decisionSourceProperty, enum: [...previousDecisionSources, 'SYSTEM'] },
      legalActions: legalActionsWithoutGlobalMinItems,
      selectedAction: {
        ...selectedActionProperty,
        oneOf: [...originalSelectedActionOneOf, endTurnSchema],
      },
    },
    oneOf: widenedBranches,
  }

  await db.command({
    collMod: 'combat-decision-events',
    validator: { $jsonSchema: widenedRoot },
    validationLevel:
      typeof options?.validationLevel === 'string' ? options.validationLevel : 'strict',
    validationAction:
      typeof options?.validationAction === 'string' ? options.validationAction : 'error',
  })
}
