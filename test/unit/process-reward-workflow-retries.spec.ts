import 'reflect-metadata'

import { PlayerInventoryGrantHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryGrantHttpClient'
import { WalletHttpClient } from '../../src/adapters/outbound/http/WalletHttpClient'
import { InMemoryRewardWorkflowRepository } from '../../src/adapters/outbound/persistence/InMemoryRewardWorkflowRepository'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { RandomSequencePort } from '../../src/application/ports/RandomSequencePort'
import type {
  RewardCreditCommand,
  RewardCreditPort,
  RewardCreditResult,
} from '../../src/application/ports/RewardCreditPort'
import type {
  RewardGrantPort,
  RewardGrantResult,
} from '../../src/application/ports/RewardGrantPort'
import {
  DEFAULT_REWARD_RETRY_POLICY,
  isRewardRetryDue,
  rewardRetryDelayMs,
  type RewardRetryPolicy,
} from '../../src/application/services/RewardRetryPolicy'
import {
  ProcessRewardWorkflow,
  type ProcessRewardWorkflowLogger,
} from '../../src/application/use-cases/ProcessRewardWorkflow'
import { RewardTable } from '../../src/domain/reward/RewardTable'
import { RandomIndex } from '../../src/domain/value-objects/RandomIndex'
import { RewardWorkflowState } from '../../src/domain/value-objects/RewardWorkflowState'
import type { Logger } from '../../src/infrastructure/observability/logger'

/**
 * Reintentos acotados y errores permanentes de `ProcessRewardWorkflow`.
 *
 * Cubren el flujo atascado en produccion el 2026-09-23/24: Player-Inventory
 * respondia `400` a `POST /api/internal/v1/inventory/grants`, Combat lo veia
 * como `error_servidor` (transitorio) y reintentaba cada segundo, sin espera ni
 * tope, mas de 26 000 veces.
 */
const silentLogger: ProcessRewardWorkflowLogger = { info: () => undefined, error: () => undefined }
const httpLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const table = RewardTable.fromRanges([
  {
    firstRow: 1,
    lastRow: 8000,
    entry: { productId: 'product-1', sku: 'sku-1', name: 'Corona', tierId: 'RARA' },
  },
])

class FixedSequence implements RandomSequencePort {
  constructor(private readonly values: number[]) {}
  nextIndex(): RandomIndex {
    const value = this.values.shift()
    if (value === undefined) throw new Error('Secuencia agotada en la prueba.')
    return RandomIndex.create(value)
  }
}

/** Reloj manual: la prueba lo coloca a voluntad respecto del ultimo fallo registrado. */
class ManualClock implements ClockPort {
  private current = new Date()
  now(): Date {
    return this.current
  }
  set(instant: Date): void {
    this.current = instant
  }
}

const chestCredit: RewardCreditResult = {
  applied: true,
  balance: 25,
  victoryProgress: 0,
  weeklyChestCount: 1,
  weeklyChestLimit: 2,
  chestEarned: true,
}

class CountingCredit implements RewardCreditPort {
  calls: RewardCreditCommand[] = []
  constructor(private readonly outcome: RewardCreditResult | Error = chestCredit) {}
  creditBattleReward(command: RewardCreditCommand): Promise<RewardCreditResult> {
    this.calls.push(command)
    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome)
  }
}

class CountingGrant implements RewardGrantPort {
  calls = 0
  constructor(private readonly outcome: RewardGrantResult | Error = { applied: true }) {}
  grant(): Promise<RewardGrantResult> {
    this.calls += 1
    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome)
  }
}

const seed = (repository: InMemoryRewardWorkflowRepository) =>
  repository.createIfAbsent(
    {
      battleId: 'battle-1',
      playerId: 'sub-1',
      teamLabel: 'A',
      seat: 0,
      creditsAmount: 2,
      victoryCreditsAmount: 2,
      finishedAt: new Date('2026-09-23T19:18:57.476Z'),
    },
    'battle:battle-1:player:sub-1:credit',
  )

const build = (options: {
  repository: InMemoryRewardWorkflowRepository
  credit?: RewardCreditPort
  grant: RewardGrantPort
  clock: ClockPort
  policy?: RewardRetryPolicy
}): ProcessRewardWorkflow =>
  new ProcessRewardWorkflow(
    options.repository,
    options.credit ?? new CountingCredit(),
    options.grant,
    new FixedSequence([4000]),
    table,
    silentLogger,
    options.clock,
    options.policy,
  )

/** Coloca el reloj `ms` despues del instante del ultimo fallo persistido. */
const advance = async (
  repository: InMemoryRewardWorkflowRepository,
  clock: ManualClock,
  id: string,
  ms: number,
): Promise<void> => {
  const workflow = await repository.findById(id)

  if (workflow === null) throw new Error('workflow inexistente')

  clock.set(new Date(workflow.updatedAt.getTime() + ms))
}

const jsonResponse = (status: number, body: unknown): Response =>
  ({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) }) as Response

const httpOptions = (fetchImpl: typeof fetch) => ({
  baseUrl: 'https://player-inventory.internal',
  callerService: 'combat',
  secret: 'secreto-compartido-de-pruebas',
  clock: { now: () => new Date('2026-09-23T19:19:00.000Z') },
  logger: httpLogger,
  fetchImpl,
})

describe('RewardRetryPolicy', () => {
  const policy: RewardRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 10 }

  it('la espera se duplica en cada fallo y se detiene en el techo', () => {
    expect([0, 1, 2, 3, 4, 5].map((attempts) => rewardRetryDelayMs(policy, attempts))).toEqual([
      0, 1_000, 2_000, 4_000, 4_000, 4_000,
    ])
  })

  it('un numero de fallos enorme no desborda la espera: sigue siendo el techo', () => {
    // El flujo de produccion llego a 26 917 intentos: 2 ** 26916 es Infinity.
    expect(rewardRetryDelayMs(policy, 26_917)).toBe(4_000)
    expect(rewardRetryDelayMs(DEFAULT_REWARD_RETRY_POLICY, 26_917)).toBe(
      DEFAULT_REWARD_RETRY_POLICY.maxDelayMs,
    )
  })

  it('sin fallos previos la espera esta vencida; con fallos, solo pasado el plazo', () => {
    const at = new Date('2026-09-23T19:00:00.000Z')
    const workflow = { attempts: 2, updatedAt: at }

    expect(isRewardRetryDue(policy, { attempts: 0, updatedAt: at }, at)).toBe(true)
    expect(isRewardRetryDue(policy, workflow, new Date(at.getTime() + 1_999))).toBe(false)
    expect(isRewardRetryDue(policy, workflow, new Date(at.getTime() + 2_000))).toBe(true)
  })

  it('por defecto: 1 s -> 5 min entre intentos y 100 fallos', () => {
    expect(DEFAULT_REWARD_RETRY_POLICY).toEqual({
      baseDelayMs: 1_000,
      maxDelayMs: 300_000,
      maxAttempts: 100,
    })
  })
})

describe('ProcessRewardWorkflow: espera entre reintentos transitorios', () => {
  it('tras un fallo NO reintenta antes de que venza la espera, y si cuando vence', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    const grant = new CountingGrant(new UpstreamServiceError('player-inventory', 'error_servidor'))
    const useCase = build({ repository, grant, clock })

    await useCase.execute(workflow.id)
    expect(grant.calls).toBe(1)

    // 1er fallo -> espera de 1 s. Un barrido cada segundo NO debe llamar de nuevo antes.
    await advance(repository, clock, workflow.id, 999)
    await useCase.execute(workflow.id)
    expect(grant.calls).toBe(1)

    await advance(repository, clock, workflow.id, 1_000)
    await useCase.execute(workflow.id)
    expect(grant.calls).toBe(2)

    // 2o fallo -> espera de 2 s.
    await advance(repository, clock, workflow.id, 1_999)
    await useCase.execute(workflow.id)
    expect(grant.calls).toBe(2)

    await advance(repository, clock, workflow.id, 2_000)
    await useCase.execute(workflow.id)
    expect(grant.calls).toBe(3)

    expect((await repository.findById(workflow.id))?.attempts).toBe(3)
  })

  it('un workflow que espera no llama a Wallet: la espera vale tambien en PENDING_CREDIT', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    const credit = new CountingCredit(new UpstreamServiceError('wallet', 'error_servidor'))
    const useCase = build({ repository, credit, grant: new CountingGrant(), clock })

    await useCase.execute(workflow.id)
    await advance(repository, clock, workflow.id, 500)
    await useCase.execute(workflow.id)

    expect(credit.calls).toHaveLength(1)
  })

  it('un workflow nuevo (sin fallos) se procesa de inmediato', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const workflow = await seed(repository)
    const grant = new CountingGrant()
    const useCase = build({ repository, grant, clock: { now: () => workflow.updatedAt } })

    await useCase.execute(workflow.id)

    expect(grant.calls).toBe(1)
    expect((await repository.findById(workflow.id))?.state).toBe(RewardWorkflowState.Completed)
  })
})

describe('ProcessRewardWorkflow: tope de reintentos', () => {
  const tight: RewardRetryPolicy = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 }

  it('agotado el tope, el workflow pasa a TERMINAL_FAILURE y deja de llamarse', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    const grant = new CountingGrant(new UpstreamServiceError('player-inventory', 'error_servidor'))
    const useCase = build({ repository, grant, clock, policy: tight })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await useCase.execute(workflow.id)
      await advance(repository, clock, workflow.id, 10)
    }

    const final = await repository.findById(workflow.id)

    expect(grant.calls).toBe(3)
    expect(final?.state).toBe(RewardWorkflowState.TerminalFailure)
    expect(final?.attempts).toBe(3)
    expect(final?.failureReason).toContain('reintentos agotados')
    expect(final?.failureReason).toContain('error_servidor')

    // Ya es terminal: ni el barrido ni un reinicio lo vuelven a llamar.
    await useCase.execute(workflow.id)
    expect(grant.calls).toBe(3)
  })

  it('el credito ya confirmado por Wallet se conserva al agotar el tope del cofre (HU-22 §66)', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    const grant = new CountingGrant(new UpstreamServiceError('player-inventory', 'error_servidor'))
    const useCase = build({ repository, grant, clock, policy: tight })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await useCase.execute(workflow.id)
      await advance(repository, clock, workflow.id, 10)
    }

    expect(await repository.findById(workflow.id)).toMatchObject({
      state: RewardWorkflowState.TerminalFailure,
      balance: 25,
      chestEarned: true,
      rewardProductId: 'product-1',
    })
  })

  it('un workflow con fallos acumulados de sobra (el atascado en produccion) SI se entrega si el destino ya responde', async () => {
    // El flujo de produccion llego a 26 917. Con el tope evaluado tras un
    // fallo NUEVO, una entrega que ahora funciona no se descarta de antemano.
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    const failing = build({
      repository,
      grant: new CountingGrant(new UpstreamServiceError('player-inventory', 'error_servidor')),
      clock,
    })

    await failing.execute(workflow.id)

    for (let index = 0; index < 500; index += 1) {
      await repository.registerRetryableFailure(workflow.id, 'inventory: error_servidor')
    }

    await advance(repository, clock, workflow.id, DEFAULT_REWARD_RETRY_POLICY.maxDelayMs)

    const grant = new CountingGrant()
    const recovered = new ProcessRewardWorkflow(
      repository,
      new CountingCredit(),
      grant,
      new FixedSequence([]),
      table,
      silentLogger,
      clock,
    )

    await recovered.execute(workflow.id)

    expect(grant.calls).toBe(1)
    expect((await repository.findById(workflow.id))?.state).toBe(RewardWorkflowState.Completed)
  })
})

describe('ProcessRewardWorkflow con los clientes HTTP reales: un 4xx permanente es terminal', () => {
  it('REGRESION: 400 de Player-Inventory -> TERMINAL_FAILURE al primer intento, UNA sola llamada', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    let httpCalls = 0
    const fetchImpl = (() => {
      httpCalls += 1

      return Promise.resolve(
        jsonResponse(400, {
          message: ['operationId must be a UUID'],
          error: 'Bad Request',
          statusCode: 400,
        }),
      )
    }) as unknown as typeof fetch
    const useCase = build({
      repository,
      grant: new PlayerInventoryGrantHttpClient(httpOptions(fetchImpl)),
      clock,
    })

    await useCase.execute(workflow.id)

    const final = await repository.findById(workflow.id)

    expect(final?.state).toBe(RewardWorkflowState.TerminalFailure)
    expect(final?.failureReason).toContain('HTTP 400')
    expect(final?.failureReason).toContain('operationId must be a UUID')
    // El credito no se revierte aunque la entrega del cofre fallo.
    expect(final?.balance).toBe(25)
    expect(httpCalls).toBe(1)

    // Ni una hora despues, ni cien barridos despues: sigue siendo UNA llamada.
    await advance(repository, clock, workflow.id, 60 * 60_000)
    for (let sweep = 0; sweep < 100; sweep += 1) {
      await useCase.execute(workflow.id)
    }

    expect(httpCalls).toBe(1)
    expect((await repository.findById(workflow.id))?.attempts).toBe(0)
  })

  it('400 de Wallet -> TERMINAL_FAILURE sin llegar a Inventory', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    const grant = new CountingGrant()
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(400, { message: 'cuerpo invalido' }))) as unknown as typeof fetch
    const useCase = build({
      repository,
      credit: new WalletHttpClient(httpOptions(fetchImpl)),
      grant,
      clock,
    })

    await useCase.execute(workflow.id)

    expect(await repository.findById(workflow.id)).toMatchObject({
      state: RewardWorkflowState.TerminalFailure,
    })
    expect(grant.calls).toBe(0)
  })

  it('503 de Player-Inventory sigue siendo transitorio: no es terminal y espera', async () => {
    const repository = new InMemoryRewardWorkflowRepository()
    const clock = new ManualClock()
    const workflow = await seed(repository)
    let httpCalls = 0
    const fetchImpl = (() => {
      httpCalls += 1

      return Promise.resolve(jsonResponse(503, {}))
    }) as unknown as typeof fetch
    const useCase = build({
      repository,
      grant: new PlayerInventoryGrantHttpClient(httpOptions(fetchImpl)),
      clock,
    })

    await useCase.execute(workflow.id)
    await advance(repository, clock, workflow.id, 100)
    await useCase.execute(workflow.id)

    expect(httpCalls).toBe(1)
    expect(await repository.findById(workflow.id)).toMatchObject({
      state: RewardWorkflowState.RewardSelected,
      attempts: 1,
    })
  })
})
