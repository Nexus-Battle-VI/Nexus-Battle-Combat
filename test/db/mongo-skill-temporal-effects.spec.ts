import 'reflect-metadata'
import { randomUUID } from 'node:crypto'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { type Db, type MongoClient } from 'mongodb'

import { MongoBattleRoomRepository } from '../../src/adapters/outbound/persistence/MongoBattleRoomRepository'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import type { SkillOutcome } from '../../src/domain/entities/BattleRoom'
import { NOW } from '../fixtures/battle'
import { battleWithCombat } from '../fixtures/basic-attack'
import { fixed, skillProfile, statEffect } from '../fixtures/skills'

/**
 * EN-031: en produccion, usar Piquete respondia INTERNAL_ERROR (MongoServerError). El efecto
 * temporal guardaba en `sourceCombatant` la entrada completa de la cola (`kind`, `playerId`,
 * `displayName`...) y el validador de `activeSkillEffects[]` (migracion 016) solo admite
 * `teamLabel`/`seat`. Le pasaba a TODA habilidad con efecto temporal. Contra el motor real,
 * con todas las migraciones: sin la correccion de `resolveTemporalEffectTemplates`, falla.
 */
const PIQUETE_ID = '9a1b2c3d-1111-4222-8333-444455556666'

describe('habilidad con efecto temporal persistida (EN-031)', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = {
      uri: `${container.getConnectionString()}/?directConnection=true`,
      databaseName: `combat_${randomUUID().replaceAll('-', '')}`,
    }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const { error } = await migrateToLatest(db)
    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }
  }, 180_000)

  afterAll(async () => {
    await client.close()
    await container?.stop()
  })

  it('Piquete (dos modificadores propios con duracion) se guarda y el efecto queda activo', async () => {
    const piquete = {
      abilityId: PIQUETE_ID,
      name: 'Piquete',
      powerCost: { mode: 'FIXED' as const, amount: 4 },
      chargeTurns: 1,
      effects: [
        statEffect('ATTACK', fixed(1), { durationTurns: 2 }),
        statEffect('DAMAGE', fixed(2), { durationTurns: 1 }),
      ],
      unlockLevel: 1,
    }
    const room = battleWithCombat({
      profiles: { a1: skillProfile({ abilities: [piquete] }), b1: skillProfile() },
    })
    const repository = new MongoBattleRoomRepository(db)
    const saved = await repository.save(room, 0)
    const plan = saved.planSkill('a1', randomUUID(), PIQUETE_ID, { teamLabel: 'B', seat: 0 })
    if (plan.kind !== 'skill') throw new Error(`plan ${plan.kind}`)
    const resolved = plan.temporalEffects.map((temporal) => ({
      targetKey: temporal.targetKey,
      effect: {
        sourceAbilityId: temporal.sourceAbilityId,
        sourceCombatant: temporal.sourceCombatant,
        statistic: (temporal.template as { statistic: 'ATTACK' }).statistic,
        operation: 'INCREASE' as const,
        amount: 1,
        remainingOwnTurns: temporal.initialRemainingOwnTurns,
      },
    }))
    const outcome: SkillOutcome = {
      attackValue: 14,
      defenseValue: 11,
      effective: true,
      effect: 'DAMAGE',
      percent: 100,
      baseDamage: 5,
      attackBonus: 1,
      damageBonus: 2,
      resolvedTemporalEffects: resolved,
    }
    const after = saved.applySkill(plan, outcome, 'cmd-x', new Date(NOW.getTime() + 5000))
    await repository.save(after, 1)

    const stored = await db
      .collection<{ _id: string; battle: { combatants: { activeSkillEffects?: unknown[] }[] } }>(
        'battle-rooms',
      )
      .findOne({ _id: after.id })
    const effects = stored?.battle.combatants.flatMap((c) => c.activeSkillEffects ?? []) ?? []

    expect(effects).toHaveLength(2)
    for (const effect of effects) {
      expect((effect as { sourceCombatant: unknown }).sourceCombatant).toEqual({
        teamLabel: 'A',
        seat: 0,
      })
    }
  })
})
