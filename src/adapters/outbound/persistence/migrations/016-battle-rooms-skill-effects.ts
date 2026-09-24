import type { Db } from 'mongodb'

import { up as restoreStakeValidator } from './011-battle-rooms-stake'

/**
 * Amplia el validador `$jsonSchema` de `battle-rooms` para la cobertura v2 de HU-19 (contrato
 * `hu-19-skills-v2` §2 y §7): en cada combatiente, la lista de efectos temporales activos
 * (`activeSkillEffects`) y la memoria de dano de 1 turno para `REFLECT_DAMAGE`
 * (`damageMemory`); y dos tipos de evento nuevos en la bitacora, `directDamageSkillUsed`
 * (dano directo, Agonia) y `healSkillUsed` -- este ultimo YA existe en el dominio desde HU-19 v1
 * (`BattleEvent.ts`, excepcion de curacion de Reanimacion) pero el validador de `011` nunca lo
 * incluyo en el `enum` de `events[].type`; se corrige aqui de paso porque esta migracion ya
 * amplia ese mismo `enum` para `directDamageSkillUsed` y porque la familia `HEALING` nueva
 * (Toque de la Vida, Vinculo Natural, Canto del Bosque, Curacion Directa, Neutralizacion de
 * Efectos) reutiliza el MISMO evento que Reanimacion (`applyHealSkill` generalizado): sin este
 * arreglo, CUALQUIER curacion (incluida Reanimacion, que ya estaba soportada) fallaria al
 * persistirse contra Mongo real.
 *
 * ADITIVA Y RETROCOMPATIBLE, NO DESTRUCTIVA -- MISMO CRITERIO que `003`..`011`: los campos
 * nuevos son OPCIONALES (ninguno entra en `required`) porque los documentos escritos por `011`
 * no los tienen y MongoDB no revalida en reposo lo ya almacenado. Ningun documento necesita
 * backfill: la capa de dominio restaura un combatiente sin `activeSkillEffects`/`damageMemory`
 * como "sin efectos temporales activos" (`[]`/`null`), exactamente igual que ya hace con
 * `currentPower`/`cooldowns` ausentes.
 *
 * `001`..`011` quedan CONGELADAS: esta es una migracion nueva. Es AUTOCONTENIDA (no importa las
 * constantes de `011`) para que una futura edicion de aquella no cambie en silencio lo que esta
 * aplica. El numero `016` es el siguiente libre: `015` es de mision (otra coleccion).
 *
 * Los enteros usan `bsonType: 'number'`: el driver escribe los numeros de JavaScript como
 * `double` salvo que se envuelvan en `Int32`.
 */
const PARTICIPANT_SCHEMA = {
  bsonType: 'object',
  required: ['kind', 'playerId', 'heroId', 'joinedAt'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'], minLength: 1 },
    heroId: { bsonType: ['string', 'null'], minLength: 1 },
    displayName: { bsonType: ['string', 'null'], minLength: 1 },
    heroLoadoutVersion: { bsonType: ['int', 'null'], minimum: 0 },
    stake: {
      bsonType: 'object',
      required: ['amount', 'holdOperationId', 'status'],
      additionalProperties: false,
      properties: {
        amount: { bsonType: ['int', 'double'], minimum: 1 },
        holdOperationId: { bsonType: 'string', minLength: 1, maxLength: 200 },
        status: {
          enum: [
            'PENDING_RESERVE',
            'ACTIVE',
            'RESERVE_FAILED',
            'RELEASED',
            'CAPTURED',
            'SETTLED_WON',
          ],
        },
      },
    },
    joinedAt: { bsonType: 'date' },
  },
} as const

const TEAM_SCHEMA = {
  bsonType: 'object',
  required: ['label', 'capacity', 'participants'],
  additionalProperties: false,
  properties: {
    label: { bsonType: 'string', minLength: 1 },
    capacity: { bsonType: 'int', minimum: 1, maximum: 3 },
    participants: { bsonType: 'array', maxItems: 3, items: PARTICIPANT_SCHEMA },
  },
} as const

const TURN_ORDER_ENTRY_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'seat', 'kind', 'playerId', 'displayName', 'heroId', 'heroSubtype'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'] },
    displayName: { bsonType: ['string', 'null'] },
    heroId: { bsonType: ['string', 'null'] },
    heroSubtype: { bsonType: ['string', 'null'] },
  },
} as const

/** Costo de Poder de una habilidad (Catalog v1): un monto fijo o todos los puntos. */
const POWER_COST_SCHEMA = {
  bsonType: 'object',
  required: ['mode'],
  additionalProperties: false,
  properties: {
    mode: { enum: ['FIXED', 'ALL_AVAILABLE'] },
    amount: { bsonType: 'number', minimum: 1 },
  },
} as const

/** Habilidad especial congelada (HU-19): identidad, costo, recarga y efectos normalizados. */
const ABILITY_SCHEMA = {
  bsonType: 'object',
  required: ['abilityId', 'name', 'powerCost', 'chargeTurns', 'effects'],
  additionalProperties: false,
  properties: {
    abilityId: { bsonType: 'string', minLength: 1, maxLength: 100 },
    name: { bsonType: 'string', minLength: 1 },
    powerCost: POWER_COST_SCHEMA,
    chargeTurns: { bsonType: 'number', minimum: 1 },
    effects: { bsonType: 'array', items: { bsonType: 'object' } },
  },
} as const

/** Perfil de combate congelado (HU-18) mas el Poder maximo y las habilidades (HU-19). */
const COMBAT_PROFILE_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['heroId', 'subtype', 'maxHealth', 'attack', 'defense', 'damage', 'activeEffects'],
  additionalProperties: false,
  properties: {
    heroId: { bsonType: 'string', minLength: 1 },
    subtype: { bsonType: 'string', minLength: 1 },
    maxHealth: { bsonType: 'number', minimum: 0 },
    attack: { bsonType: ['number', 'null'], minimum: 0 },
    defense: { bsonType: 'number', minimum: 0 },
    damage: { bsonType: ['object', 'null'] },
    activeEffects: { bsonType: 'array', items: { bsonType: 'object' } },
    maxPower: { bsonType: 'number', minimum: 0 },
    abilities: { bsonType: 'array', items: ABILITY_SCHEMA },
  },
} as const

/**
 * HU-19 v2 (contrato §2): efecto temporal ACTIVO ya resuelto -- `amount` es un entero (el dado,
 * si lo hubo, ya se tiro UNA vez al aplicar la habilidad que lo origino, contra
 * `RandomSequencePort`), y `remainingOwnTurns` es el contador real de "turnos propios" del
 * combatiente objetivo (misma convencion que `cooldowns`, HU-19 v1 §5.3). Dos formas: un
 * modificador de estadistica (`statistic`/`operation`/`amount`) o una inmunidad estructural
 * (`immunityCode`, contrato §5, sin magnitud).
 */
const ACTIVE_SKILL_EFFECT_SCHEMA = {
  bsonType: 'object',
  required: ['sourceAbilityId', 'sourceCombatant', 'remainingOwnTurns'],
  additionalProperties: false,
  properties: {
    sourceAbilityId: { bsonType: 'string', minLength: 1, maxLength: 100 },
    sourceCombatant: {
      bsonType: 'object',
      required: ['teamLabel', 'seat'],
      additionalProperties: false,
      properties: {
        teamLabel: { bsonType: 'string', minLength: 1 },
        seat: { bsonType: 'number', minimum: 0 },
      },
    },
    statistic: { enum: ['ATTACK', 'DAMAGE', 'DEFENSE', 'HEALING'] },
    operation: { enum: ['INCREASE', 'DECREASE'] },
    amount: { bsonType: 'number' },
    immunityCode: { bsonType: 'string', minLength: 1 },
    remainingOwnTurns: { bsonType: 'number', minimum: 1 },
  },
} as const

/** HU-19 v2 (contrato §6): memoria de 1 turno propio del dano recibido, para `REFLECT_DAMAGE`. */
const DAMAGE_MEMORY_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['amount', 'remainingOwnTurns'],
  additionalProperties: false,
  properties: {
    amount: { bsonType: 'number', minimum: 0 },
    remainingOwnTurns: { bsonType: 'number', minimum: 1 },
  },
} as const

const COMBATANT_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'seat', 'currentHealth', 'profile'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
    currentHealth: { bsonType: ['number', 'null'], minimum: 0 },
    profile: COMBAT_PROFILE_SCHEMA,
    currentPower: { bsonType: ['number', 'null'], minimum: 0 },
    cooldowns: { bsonType: 'object' },
    activeSkillEffects: { bsonType: 'array', items: ACTIVE_SKILL_EFFECT_SCHEMA },
    damageMemory: DAMAGE_MEMORY_SCHEMA,
  },
} as const

const BATTLE_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['startedAt', 'turnOrder', 'turnsCompleted'],
  additionalProperties: false,
  properties: {
    startedAt: { bsonType: 'date' },
    turnStartedAt: { bsonType: 'date' },
    turnOrder: { bsonType: 'array', minItems: 2, maxItems: 6, items: TURN_ORDER_ENTRY_SCHEMA },
    turnsCompleted: { bsonType: 'number', minimum: 0 },
    combatants: { bsonType: ['array', 'null'], maxItems: 6, items: COMBATANT_SCHEMA },
  },
} as const

/** Estado final de un equipo (contrato §5). */
const TEAM_STANDING_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'remainingHealth', 'maxHealth', 'lifePercent', 'eliminated'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    remainingHealth: { bsonType: 'number', minimum: 0 },
    maxHealth: { bsonType: 'number', minimum: 0 },
    lifePercent: { bsonType: 'number', minimum: 0, maximum: 100 },
    eliminated: { bsonType: 'bool' },
  },
} as const

/** Resultado por participante (contrato §5). */
const PARTICIPANT_OUTCOME_SCHEMA = {
  bsonType: 'object',
  required: ['teamLabel', 'seat', 'kind', 'playerId', 'displayName', 'heroId', 'result'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
    kind: { enum: ['HUMAN', 'AI'] },
    playerId: { bsonType: ['string', 'null'] },
    displayName: { bsonType: ['string', 'null'] },
    heroId: { bsonType: ['string', 'null'] },
    result: { enum: ['WON', 'LOST', 'NO_WINNER'] },
  },
} as const

const DISCONNECTED_SCHEMA = {
  bsonType: ['object', 'null'],
  required: ['teamLabel', 'seat'],
  additionalProperties: false,
  properties: {
    teamLabel: { bsonType: 'string', minLength: 1 },
    seat: { bsonType: 'number', minimum: 0 },
  },
} as const

/** Resultado unico de la batalla (contrato §5): JSON puro, fechas ISO de texto. */
const BATTLE_RESULT_SCHEMA = {
  bsonType: 'object',
  required: [
    'reason',
    'outcome',
    'winnerTeamLabel',
    'finishedAt',
    'tiebreak',
    'disconnected',
    'teams',
    'participants',
  ],
  additionalProperties: false,
  properties: {
    reason: { enum: ['ELIMINATION', 'DISCONNECTION', 'TIME_LIMIT'] },
    outcome: { enum: ['WIN', 'NO_WINNER'] },
    winnerTeamLabel: { bsonType: ['string', 'null'] },
    finishedAt: { bsonType: 'string', minLength: 1 },
    tiebreak: { enum: ['LIFE_PERCENT', 'ABSOLUTE_LIFE', null] },
    disconnected: DISCONNECTED_SCHEMA,
    teams: { bsonType: 'array', minItems: 2, maxItems: 2, items: TEAM_STANDING_SCHEMA },
    participants: {
      bsonType: 'array',
      minItems: 1,
      maxItems: 6,
      items: PARTICIPANT_OUTCOME_SCHEMA,
    },
  },
} as const

const EVENT_SCHEMA = {
  bsonType: 'object',
  required: ['seq', 'type', 'occurredAt', 'payload'],
  additionalProperties: false,
  properties: {
    seq: { bsonType: 'number', minimum: 1 },
    type: {
      enum: [
        'battleStarted',
        'turnAdvanced',
        'basicAttackResolved',
        'skillUsed',
        /** HU-19 v1: existia en el dominio desde el principio; el validador nunca lo tuvo. */
        'healSkillUsed',
        'turnTimedOut',
        'battleFinished',
        /** HU-19 v2 (contrato §3): dano directo sin resolucion de Ataque/Defensa (Agonia). */
        'directDamageSkillUsed',
      ],
    },
    occurredAt: { bsonType: 'date' },
    payload: { bsonType: 'object' },
  },
} as const

const HANDLED_COMMAND_SCHEMA = {
  bsonType: 'object',
  required: ['commandId', 'seq'],
  additionalProperties: false,
  properties: {
    commandId: { bsonType: 'string', minLength: 1, maxLength: 100 },
    seq: { bsonType: 'number', minimum: 1 },
  },
} as const

const REQUIRED = ['_id', 'mode', 'status', 'teams', 'reward', 'createdBy', 'createdAt', 'version']

const VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: REQUIRED,
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'string', minLength: 1 },
      mode: { enum: ['PVP', 'PVE'] },
      status: {
        enum: ['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE', 'FINISHED', 'CANCELLED'],
      },
      teams: { bsonType: 'array', minItems: 2, maxItems: 2, items: TEAM_SCHEMA },
      reward: {
        bsonType: 'object',
        required: ['amount'],
        additionalProperties: false,
        properties: { amount: { bsonType: ['int', 'double'], minimum: 0 } },
      },
      createdBy: { bsonType: 'string', minLength: 1 },
      createdAt: { bsonType: 'date' },
      version: { bsonType: 'int', minimum: 0 },
      battle: BATTLE_SCHEMA,
      events: { bsonType: 'array', items: EVENT_SCHEMA },
      handledCommands: { bsonType: 'array', items: HANDLED_COMMAND_SCHEMA },
      result: { ...BATTLE_RESULT_SCHEMA, bsonType: ['object', 'null'] },
    },
  },
}

export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'battle-rooms',
    validator: VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  })
}

/** Vuelve al validador de `011`. Las salas con efectos temporales ya escritas no se reescriben. */
export const down = async (db: Db): Promise<void> => {
  await restoreStakeValidator(db)
}
