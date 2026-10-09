import { parseAutomaticEvaluationArgs } from '../../src/infrastructure/evaluation/automatic-evaluation-worker'
import { parseRollbackArgs } from '../../src/infrastructure/evaluation/rollback-ai-model'

describe('automatic evaluation and rollback CLIs (EN-037.3)', () => {
  it('worker defaults to a real FULL evaluation cadence and supports one-shot execution', () => {
    const parsed = parseAutomaticEvaluationArgs(['--once', '--source-commit', 'abc123'])

    expect(parsed).toMatchObject({
      once: true,
      seedStart: 3_000_000,
      seedCount: 50,
      mctsSeedCount: 10,
      maxPlies: 500,
      sourceCommit: 'abc123',
      skipExpensiveMcts: false,
    })
  })

  it('worker rejects an unsafe heartbeat/lease relation', () => {
    expect(() =>
      parseAutomaticEvaluationArgs([
        '--lease-duration-ms',
        '3000',
        '--heartbeat-interval-ms',
        '1000',
      ]),
    ).toThrow('tres latidos')
  })

  it('rollback requires explicit idempotency, target and reason', () => {
    expect(
      parseRollbackArgs([
        '--operation-id',
        'incident-42',
        '--target-version',
        'model-v1',
        '--reason',
        'regresion operativa',
      ]),
    ).toEqual({
      databaseName: 'combat',
      operationId: 'incident-42',
      targetVersion: 'model-v1',
      reason: 'regresion operativa',
    })
    expect(() => parseRollbackArgs(['--target-version', 'model-v1'])).toThrow('--operation-id')
  })
})
