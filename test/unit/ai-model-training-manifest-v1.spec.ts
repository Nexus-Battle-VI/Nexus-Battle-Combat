import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseAndValidateModelTrainingManifest } from '../../src/infrastructure/ai/AiModelTrainingManifestV1'

const FIXTURE_DIR = join(__dirname, '../fixtures/ai-model-registry')

describe('parseAndValidateModelTrainingManifest (EN-037.1, Management #570 §20-21, §36)', () => {
  it('parses a REAL training-manifest.json produced by the #567 pipeline (fixture)', () => {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, 'training-manifest.json'), 'utf8'))

    const manifest = parseAndValidateModelTrainingManifest(raw)

    expect(manifest.trainingManifestVersion).toBe('training-manifest-v1')
    expect(manifest.modelArchitectureVersion).toBe('candidate-mlp-v1')
    expect(manifest.featureSchemaVersion).toBe('feature-schema-v1')
    expect(manifest.featureDimension).toBe(72)
    expect(manifest.onnxOpsetVersion).toBe(18)
    expect(manifest.artifactPurpose).toBe('SMOKE_TEST')
    expect(manifest.trainingConfigSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.onnxArtifactSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a manifest with an unknown featureSchemaVersion before it can become a candidate', () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'training-manifest.json'), 'utf8'),
    ) as Record<string, unknown>

    expect(() =>
      parseAndValidateModelTrainingManifest({ ...raw, featureSchemaVersion: 'v999' }),
    ).toThrow()
  })
})
