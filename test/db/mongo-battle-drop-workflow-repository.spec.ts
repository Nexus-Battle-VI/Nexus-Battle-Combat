import { randomUUID } from 'node:crypto'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoBattleDropWorkflowRepository } from '../../src/adapters/outbound/persistence/MongoBattleDropWorkflowRepository'
import { battleDropWorkflowId } from '../../src/application/ports/BattleDropWorkflowRepositoryPort'
import type { VersusDropResolution } from '../../src/domain/entities/VersusDrop'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'

/**
 * HU-30 (Task HU-30.2): persistencia real del derecho de drop diferido.
 *
 * El esquema de `battle-drop-workflows` exige `defeatEventSeq` como BSON
 * `int`; un numero JS plano serializa como `double` y la validacion del
 * driver lo rechazaria. Solo una prueba contra Mongo REAL (no el doble en
 * memoria que usan las suites unitarias) puede detectar esta clase de fallo.
 */
describe('MongoBattleDropWorkflowRepository', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
  }, 120_000)

  afterAll(async () => {
    await client.close()
    await container.stop()
  })

  const pendingResolution = (productInstanceId: string): VersusDropResolution => ({
    status: 'PENDING',
    evaluations: [
      {
        productInstanceId,
        productId: `producto-${productInstanceId}`,
        itemId: `item-${productInstanceId}`,
        dropChanceBasisPoints: 500,
        rollBasisPoints: 10,
        eligible: true,
      },
    ],
    selected: {
      productInstanceId,
      productId: `producto-${productInstanceId}`,
      itemId: `item-${productInstanceId}`,
      dropChanceBasisPoints: 500,
    },
  })

  it('crea el derecho contra el esquema real, es idempotente y recorre el ciclo PENDING -> CREDITED -> notificado', async () => {
    const repository = new MongoBattleDropWorkflowRepository(db)
    const battleId = `battle-${randomUUID()}`
    const intent = {
      battleId,
      defeatEventSeq: 3,
      killerPlayerId: 'a1',
      defeatedPlayerId: 'b1',
      resolution: pendingResolution('unit-1'),
    }

    const created = await repository.createIfAbsent(intent)
    expect(created.state).toBe('PENDING')
    expect(created.defeatEventSeq).toBe(3)

    // Idempotente: una segunda llegada del MISMO evento letal no crea un
    // segundo derecho ni sobreescribe el existente.
    const repeated = await repository.createIfAbsent(intent)
    expect(repeated).toEqual(created)

    const id = battleDropWorkflowId(battleId, 3)
    const unsettledBefore = await repository.findUnsettled(50)
    expect(unsettledBefore.map((workflow) => workflow.id)).toContain(id)

    const receipt = {
      operationId: randomUUID(),
      battleId,
      defeatEventSeq: 3,
      sourcePlayerId: 'b1',
      targetPlayerId: 'a1',
      productInstanceId: 'unit-1',
      productId: 'producto-unit-1',
      itemId: 'item-unit-1',
      creditedAt: new Date().toISOString(),
    }
    await repository.markCredited(id, receipt)
    const credited = await repository.findById(id)
    expect(credited?.state).toBe('CREDITED')
    expect(credited?.receipt).toEqual(receipt)
    expect(await repository.findUnsettled(50)).toEqual([])

    const unnotified = await repository.findUnnotified(50)
    expect(unnotified.map((workflow) => workflow.id)).toContain(id)

    await repository.markNotified(id, 'winner')
    await repository.markNotified(id, 'loser')
    const notified = await repository.findById(id)
    expect(notified?.winnerNotified).toBe(true)
    expect(notified?.loserNotified).toBe(true)
    expect((await repository.findUnnotified(50)).map((workflow) => workflow.id)).not.toContain(id)

    expect(await repository.isBattleClosed(battleId)).toBe(false)
    await repository.markBattleClosed(battleId)
    expect(await repository.isBattleClosed(battleId)).toBe(true)
    // Idempotente: cerrar dos veces la misma batalla no falla.
    await expect(repository.markBattleClosed(battleId)).resolves.toBeUndefined()
  })

  it('un fallo de transferencia vuelve FAILED_RETRYABLE y sigue saliendo en los no liquidados', async () => {
    const repository = new MongoBattleDropWorkflowRepository(db)
    const battleId = `battle-${randomUUID()}`
    const id = battleDropWorkflowId(battleId, 1)
    await repository.createIfAbsent({
      battleId,
      defeatEventSeq: 1,
      killerPlayerId: 'a2',
      defeatedPlayerId: 'b2',
      resolution: pendingResolution('unit-2'),
    })

    await repository.markFailed(id)
    const failed = await repository.findById(id)
    expect(failed?.state).toBe('FAILED_RETRYABLE')
    expect((await repository.findUnsettled(50)).map((workflow) => workflow.id)).toContain(id)
  })

  it('NO_DROP se persiste contra el esquema real y nunca aparece como pendiente de liquidar o notificar', async () => {
    const repository = new MongoBattleDropWorkflowRepository(db)
    const battleId = `battle-${randomUUID()}`
    const id = battleDropWorkflowId(battleId, 5)
    const workflow = await repository.createIfAbsent({
      battleId,
      defeatEventSeq: 5,
      killerPlayerId: 'a3',
      defeatedPlayerId: 'b3',
      resolution: { status: 'NO_DROP', evaluations: [] },
    })

    expect(workflow.state).toBe('NO_DROP')
    expect((await repository.findUnsettled(50)).map((entry) => entry.id)).not.toContain(id)
    expect((await repository.findUnnotified(50)).map((entry) => entry.id)).not.toContain(id)
  })
})
