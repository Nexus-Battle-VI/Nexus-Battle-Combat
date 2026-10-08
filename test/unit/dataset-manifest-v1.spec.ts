import {
  isDatasetTrainable,
  parseAndValidateDatasetManifest,
  type DatasetManifestCountsV1,
} from '../../src/infrastructure/ai/DatasetManifestV1'

const validCounts: DatasetManifestCountsV1 = {
  battles: 4,
  decisions: 7,
  candidates: 13,
  trainBattles: 2,
  validationBattles: 1,
  testBattles: 1,
  trainDecisions: 3,
  validationDecisions: 2,
  testDecisions: 2,
}

const validManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifestVersion: 'dataset-manifest-v1',
  featureSchemaVersion: 'feature-schema-v1',
  featureDimension: 72,
  teacherVersion: 'mcts-teacher-v1',
  utilityVersion: 'pve-utility-v1',
  cutoff: '2027-01-01T00:00:00Z',
  sourceCommit: 'abc123',
  datasetSeed: 42,
  counts: validCounts,
  inputFingerprint: 'a'.repeat(64),
  outputFingerprint: 'b'.repeat(64),
  ...overrides,
})

describe('parseAndValidateDatasetManifest (EN-037.2, Management #571 §7)', () => {
  it('parses a well-formed dataset-manifest-v1', () => {
    const manifest = parseAndValidateDatasetManifest(validManifest())
    expect(manifest.featureSchemaVersion).toBe('feature-schema-v1')
    expect(manifest.counts).toEqual(validCounts)
    expect(manifest.outputFingerprint).toBe('b'.repeat(64))
  })

  it('rejects an unknown manifestVersion', () => {
    expect(() =>
      parseAndValidateDatasetManifest(validManifest({ manifestVersion: 'v999' })),
    ).toThrow()
  })

  it('rejects a missing required field', () => {
    const raw = validManifest()
    delete raw.sourceCommit
    expect(() => parseAndValidateDatasetManifest(raw)).toThrow()
  })

  it('rejects a non-object counts field', () => {
    expect(() =>
      parseAndValidateDatasetManifest(validManifest({ counts: 'not-an-object' })),
    ).toThrow()
  })
})

describe('isDatasetTrainable (EN-037.2, Management #571 §7.3)', () => {
  it('is trainable when all three splits have at least one decision', () => {
    expect(isDatasetTrainable(validCounts)).toBe(true)
  })

  it.each(['trainDecisions', 'validationDecisions', 'testDecisions'] as const)(
    'is NOT trainable when %s is zero (matches Python DatasetNotTrainableError)',
    (field) => {
      expect(isDatasetTrainable({ ...validCounts, [field]: 0 })).toBe(false)
    },
  )
})
