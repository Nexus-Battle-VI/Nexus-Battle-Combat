import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../../src/infrastructure/config/env'

jest.mock('../../src/infrastructure/ai/OnnxRuntimeNeuralInferenceAdapter', () => ({
  OnnxRuntimeNeuralInferenceAdapter: {
    create: jest.fn().mockResolvedValue({
      score: jest.fn().mockResolvedValue(new Float32Array([0.1])),
    }),
  },
}))

// `jest.mock(...)` arriba se "hoistea" por encima de estos imports (ts-jest/
// babel-plugin-jest-hoist): el import normal ya ve la version mockeada.
import { loadNeuralPrimaryPolicy } from '../../src/infrastructure/ai/NeuralModelArtifactLoader'
import { OnnxRuntimeNeuralInferenceAdapter } from '../../src/infrastructure/ai/OnnxRuntimeNeuralInferenceAdapter'

const silentLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
// `create` es un metodo ESTATICO real (nunca de instancia, no usa `this`);
// extraerlo para los `expect(...).toHaveBeenCalled()` de abajo siempre
// dispara `unbound-method` porque la firma de la clase real no lo declara
// `this: void` -- inherente a mockear un metodo estatico real, no un riesgo
// de perder el `this` en runtime (no lo usa).
// eslint-disable-next-line @typescript-eslint/unbound-method
const createMock = OnnxRuntimeNeuralInferenceAdapter.create as jest.Mock

/**
 * `loadNeuralPrimaryPolicy` (EN-036.4, Management #568 §129 "AM-01..05"):
 * `OnnxRuntimeNeuralInferenceAdapter.create` esta mockeado -- no depende
 * del binario nativo ni de un `model.onnx` real -- los campos de contrato
 * (manifest/hash/artifactPurpose) SI se validan de verdad contra archivos
 * temporales reales, nunca simulados.
 */
describe('loadNeuralPrimaryPolicy (EN-036.4, Management #568 §40-45, §129)', () => {
  let dir: string

  beforeEach(async () => {
    jest.clearAllMocks()
    dir = await mkdtemp(path.join(tmpdir(), 'neural-loader-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const writeArtifact = async (options: {
    readonly artifactPurpose?: string
    readonly onnxBytes?: Buffer
    readonly tamperHash?: boolean
    readonly manifestOverrides?: Record<string, unknown>
  }): Promise<{ onnxPath: string; manifestPath: string }> => {
    const onnxBytes = options.onnxBytes ?? Buffer.from('fake-onnx-bytes-for-testing')
    const onnxPath = path.join(dir, 'model.onnx')
    await writeFile(onnxPath, onnxBytes)

    const realHash = createHash('sha256').update(onnxBytes).digest('hex')
    const manifest = {
      trainingManifestVersion: 'training-manifest-v1',
      modelArchitectureVersion: 'candidate-mlp-v1',
      featureSchemaVersion: 'feature-schema-v1',
      featureDimension: 72,
      onnxOpsetVersion: 18,
      onnxArtifactSha256: options.tamperHash === true ? `${realHash.slice(0, -1)}0` : realHash,
      modelStateSha256: 'a'.repeat(64),
      artifactPurpose: options.artifactPurpose ?? 'CANDIDATE',
      modelContract: {
        inputName: 'candidate_features',
        inputDtype: 'float32',
        inputRank: 2,
        featureDimension: 72,
        candidateAxisDynamic: true,
        outputName: 'scores',
        outputDtype: 'float32',
        outputRank: 1,
      },
      ...options.manifestOverrides,
    }
    const manifestPath = path.join(dir, 'training-manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest))

    return { onnxPath, manifestPath }
  }

  it('AM-01: NEURAL_POLICY_ENABLED=false -> primary null, sin tocar el filesystem', async () => {
    const config = loadConfig({ NEURAL_POLICY_ENABLED: 'false' })
    const result = await loadNeuralPrimaryPolicy(config, silentLogger)
    expect(result).toBeNull()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('AM-02: habilitada + artefacto CANDIDATE valido -> primaria NEURAL', async () => {
    const { onnxPath, manifestPath } = await writeArtifact({ artifactPurpose: 'CANDIDATE' })
    const config = loadConfig({
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: onnxPath,
      NEURAL_MODEL_MANIFEST_PATH: manifestPath,
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).not.toBeNull()
    expect(result?.source).toBe('NEURAL')
    expect(silentLogger.info).toHaveBeenCalledWith('neural_model_loaded', expect.any(Object))
  })

  it('AM-03: habilitada + manifest ausente -> primary null (fail-open, nunca una excepcion)', async () => {
    const config = loadConfig({
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: path.join(dir, 'model.onnx'),
      NEURAL_MODEL_MANIFEST_PATH: path.join(dir, 'training-manifest.json'),
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).toBeNull()
    expect(silentLogger.error).toHaveBeenCalledWith('neural_model_unavailable', expect.any(Object))
  })

  it('AM-04: artifactPurpose=SMOKE_TEST + NODE_ENV=production -> SIEMPRE null, sin excepcion', async () => {
    const { onnxPath, manifestPath } = await writeArtifact({ artifactPurpose: 'SMOKE_TEST' })
    const config = loadConfig({
      NODE_ENV: 'production',
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: onnxPath,
      NEURAL_MODEL_MANIFEST_PATH: manifestPath,
      NEURAL_ALLOW_SMOKE_MODEL: 'true',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'pool',
      COGNITO_CLIENT_ID: 'client',
      PERSISTENCE_DRIVER: 'mongo',
      MONGODB_URI: 'mongodb://localhost/combat',
      ACCOUNT_SERVICE_BASE_URL: 'http://account',
      PLAYER_INVENTORY_SERVICE_BASE_URL: 'http://inventory',
      CATALOG_SERVICE_BASE_URL: 'http://catalog',
      WALLET_SERVICE_BASE_URL: 'http://wallet',
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).toBeNull()
  })

  it('AM-05: artifactPurpose=SMOKE_TEST fuera de produccion + NEURAL_ALLOW_SMOKE_MODEL=true -> disponible', async () => {
    const { onnxPath, manifestPath } = await writeArtifact({ artifactPurpose: 'SMOKE_TEST' })
    const config = loadConfig({
      NODE_ENV: 'development',
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: onnxPath,
      NEURAL_MODEL_MANIFEST_PATH: manifestPath,
      NEURAL_ALLOW_SMOKE_MODEL: 'true',
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).not.toBeNull()
    expect(result?.source).toBe('NEURAL')
  })

  it('SMOKE_TEST fuera de produccion SIN NEURAL_ALLOW_SMOKE_MODEL -> null', async () => {
    const { onnxPath, manifestPath } = await writeArtifact({ artifactPurpose: 'SMOKE_TEST' })
    const config = loadConfig({
      NODE_ENV: 'development',
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: onnxPath,
      NEURAL_MODEL_MANIFEST_PATH: manifestPath,
      NEURAL_ALLOW_SMOKE_MODEL: 'false',
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).toBeNull()
  })

  it('#568 §42: hash real distinto del declarado en el manifest -> null, nunca carga', async () => {
    const { onnxPath, manifestPath } = await writeArtifact({ tamperHash: true })
    const config = loadConfig({
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: onnxPath,
      NEURAL_MODEL_MANIFEST_PATH: manifestPath,
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).toBeNull()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('#568 §90: featureDimension incompatible -> null antes de llegar al runtime', async () => {
    const { onnxPath, manifestPath } = await writeArtifact({
      manifestOverrides: { featureDimension: 73 },
    })

    const config = loadConfig({
      NEURAL_POLICY_ENABLED: 'true',
      NEURAL_MODEL_ONNX_PATH: onnxPath,
      NEURAL_MODEL_MANIFEST_PATH: manifestPath,
    })

    const result = await loadNeuralPrimaryPolicy(config, silentLogger)

    expect(result).toBeNull()
    expect(createMock).not.toHaveBeenCalled()
  })
})
