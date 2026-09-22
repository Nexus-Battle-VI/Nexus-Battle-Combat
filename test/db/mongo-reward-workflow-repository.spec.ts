import 'reflect-metadata'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/MongoRewardWorkflowRepository'
import type { RewardWorkflowIntent } from '../../src/application/ports/RewardWorkflowRepositoryPort'
import { RewardWorkflowState } from '../../src/domain/value-objects/RewardWorkflowState'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'

/**
 * Persistencia del `RewardWorkflow` (HU-22, `hu-22-reward-contract-v1` §8)
 * contra un MongoDB REAL, en contenedor. Comprueba lo que un doble no puede:
 * que la migracion `010` cree la coleccion y su validador `$jsonSchema`, y
 * que cada transicion sea de verdad atomica -- filtrada por el `state` de
 * origen esperado, con `findOneAndUpdate` -- incluida la reanudacion tras
 * "reiniciar" el proceso (una segunda instancia del repositorio sobre la
 * MISMA base, HU-22 §68).
 */
describe('MongoRewardWorkflowRepository', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let repository: MongoRewardWorkflowRepository

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

    repository = new MongoRewardWorkflowRepository(db)
  }, 120_000)

  afterAll(async () => {
    await client.close()
    await container.stop()
  })

  let battleCounter = 0
  const intent = (overrides: Partial<RewardWorkflowIntent> = {}): RewardWorkflowIntent => {
    battleCounter += 1

    return {
      battleId: overrides.battleId ?? `room-${String(battleCounter)}`,
      playerId: overrides.playerId ?? 'sub-1',
      teamLabel: overrides.teamLabel ?? 'A',
      seat: overrides.seat ?? 0,
      creditsAmount: overrides.creditsAmount ?? 2,
      victoryCreditsAmount: overrides.victoryCreditsAmount ?? 2,
      finishedAt: overrides.finishedAt ?? new Date('2026-09-22T10:06:00.000Z'),
    }
  }

  it('crea el workflow en PENDING_CREDIT con id determinista battleId:playerId', async () => {
    const created = await repository.createIfAbsent(
      intent({ battleId: 'room-det', playerId: 'sub-det' }),
      'op-det',
    )

    expect(created.id).toBe('room-det:sub-det')
    expect(created.state).toBe(RewardWorkflowState.PendingCredit)
  })

  it('createIfAbsent es idempotente: no sobrescribe un workflow ya existente', async () => {
    const battleId = 'room-idem'
    const first = await repository.createIfAbsent(intent({ battleId, creditsAmount: 2 }), 'op-a')
    const second = await repository.createIfAbsent(intent({ battleId, creditsAmount: 4 }), 'op-b')

    expect(second.creditsAmount).toBe(2)
    expect(second.walletOperationId).toBe(first.walletOperationId)
  })

  it('recorre las transiciones completas: PENDING_CREDIT -> CHEST_ELIGIBLE -> REWARD_SELECTED -> COMPLETED', async () => {
    const battleId = 'room-full'
    const workflow = await repository.createIfAbsent(intent({ battleId }), 'op-full')

    const afterWallet = await repository.applyWalletResult(workflow.id, {
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
    })
    expect(afterWallet.state).toBe(RewardWorkflowState.ChestEligible)

    const afterSelection = await repository.applySelection(workflow.id, {
      productId: 'product-1',
      sku: 'sku-1',
      name: 'Espada',
      inventoryOperationId: 'inv-op-full',
    })
    expect(afterSelection.state).toBe(RewardWorkflowState.RewardSelected)

    const completed = await repository.applyCompleted(workflow.id)
    expect(completed).toMatchObject({
      state: RewardWorkflowState.Completed,
      rewardProductId: 'product-1',
      chestEarned: true,
    })
  })

  it('una transicion desde un estado de origen que ya no coincide es un no-op (no rompe, no repite)', async () => {
    const battleId = 'room-noop'
    const workflow = await repository.createIfAbsent(intent({ battleId }), 'op-noop')
    await repository.applyWalletResult(workflow.id, {
      balance: 1,
      victoryProgress: 0,
      weeklyChestCount: 0,
      chestEarned: false,
    })

    // Ya esta en CREDIT_CONFIRMED: reintentar applyWalletResult (que exige
    // PENDING_CREDIT) no debe cambiar nada.
    const replay = await repository.applyWalletResult(workflow.id, {
      balance: 999,
      victoryProgress: 999,
      weeklyChestCount: 999,
      chestEarned: true,
    })

    expect(replay.balance).toBe(1)
    expect(replay.chestEarned).toBe(false)
  })

  it('un workflow reinicia el "proceso" (nueva instancia del repositorio) y reanuda desde el estado persistido', async () => {
    const battleId = 'room-restart'
    const workflow = await repository.createIfAbsent(intent({ battleId }), 'op-restart')
    await repository.applyWalletResult(workflow.id, {
      balance: 20,
      victoryProgress: 0,
      weeklyChestCount: 1,
      chestEarned: true,
    })

    // Simula un reinicio: una instancia NUEVA del repositorio sobre la misma
    // base de datos debe ver exactamente el mismo estado (nada vive solo en
    // memoria del proceso anterior).
    const afterRestart = new MongoRewardWorkflowRepository(db)
    const recovered = await afterRestart.findById(workflow.id)

    expect(recovered).toMatchObject({ state: RewardWorkflowState.ChestEligible, chestEarned: true })
  })

  it('findNonTerminal devuelve solo workflows sin llegar a COMPLETED/TERMINAL_FAILURE', async () => {
    const pending = await repository.createIfAbsent(intent({ battleId: 'room-nt-1' }), 'op-nt-1')
    const completed = await repository.createIfAbsent(
      intent({ battleId: 'room-nt-2', creditsAmount: 1, victoryCreditsAmount: 0 }),
      'op-nt-2',
    )
    await repository.applyWalletResult(completed.id, {
      balance: 1,
      victoryProgress: 0,
      weeklyChestCount: 0,
      chestEarned: false,
    })
    await repository.applyCompleted(completed.id)

    const nonTerminal = await repository.findNonTerminal(100)
    const ids = nonTerminal.map((workflow) => workflow.id)

    expect(ids).toContain(pending.id)
    expect(ids).not.toContain(completed.id)
  })

  it('findByBattleAndPlayer localiza el workflow del jugador en esa batalla', async () => {
    await repository.createIfAbsent(
      intent({ battleId: 'room-lookup', playerId: 'sub-lookup' }),
      'op-lookup',
    )

    const found = await repository.findByBattleAndPlayer('room-lookup', 'sub-lookup')
    const missing = await repository.findByBattleAndPlayer('room-lookup', 'sub-otro')

    expect(found?.playerId).toBe('sub-lookup')
    expect(missing).toBeNull()
  })

  it('applyTerminalFailure funciona desde cualquier estado no terminal y registra el motivo', async () => {
    const workflow = await repository.createIfAbsent(intent({ battleId: 'room-fail' }), 'op-fail')

    const failed = await repository.applyTerminalFailure(workflow.id, 'wallet: rechazo terminal')

    expect(failed).toMatchObject({
      state: RewardWorkflowState.TerminalFailure,
      failureReason: 'wallet: rechazo terminal',
    })
  })

  it('registerRetryableFailure incrementa attempts sin cambiar el estado', async () => {
    const workflow = await repository.createIfAbsent(intent({ battleId: 'room-retry' }), 'op-retry')

    await repository.registerRetryableFailure(workflow.id, 'wallet: error_servidor')
    await repository.registerRetryableFailure(workflow.id, 'wallet: error_servidor')

    const current = await repository.findById(workflow.id)
    expect(current?.attempts).toBe(2)
    expect(current?.state).toBe(RewardWorkflowState.PendingCredit)
  })
})
