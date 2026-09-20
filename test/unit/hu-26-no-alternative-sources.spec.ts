import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guarda estatica de HU-26: el estudio valida el codigo PRODUCTIVO, no una
 * reimplementacion, y separa con claridad la normalidad (createNormalSequence)
 * del indice funcional (create().nextIndex()).
 */
const TOOLS = join(__dirname, '..', '..', 'tools', 'hu-26')

const read = (file: string): string =>
  readFileSync(join(TOOLS, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const TYPESCRIPT_FILES = readdirSync(TOOLS).filter((file) => file.endsWith('.ts'))

describe('HU-26: el harness usa el codigo productivo y no otra fuente', () => {
  it('vigila todos los modulos TypeScript del harness', () => {
    expect([...TYPESCRIPT_FILES].sort()).toEqual([
      'generate-samples.ts',
      'index-sample-generation.ts',
      'production-factory.ts',
      'sample-fingerprint.ts',
      'sample-generation.ts',
      'study-config.ts',
    ])
  })

  it.each(TYPESCRIPT_FILES)(
    '%s no usa Math.random ni fuentes de aleatoriedad de node:crypto',
    (file) => {
      expect(read(file)).not.toMatch(
        /Math\s*\.\s*random|randomBytes|randomInt|randomUUID|getRandomValues/,
      )
    },
  )

  it.each(TYPESCRIPT_FILES)('%s no reimplementa MT19937, Box-Muller ni la CDF', (file) => {
    const code = read(file)

    expect(code).not.toMatch(
      /new Mt19937\s*\(|new BoxMullerNormalGenerator|standardNormalCdf|from '[^']*\/Mt19937'/,
    )
    expect(code).not.toMatch(/init_genrand|genrand_res53|Math\.log\(|Math\.cos\(|Math\.sin\(/)
  })

  it('la muestra normal sale SOLO de createNormalSequence().nextNormal()', () => {
    const code = read('sample-generation.ts')

    expect(code).toMatch(/createNormalSequence\(seed\)/)
    expect(code).toMatch(/nextNormal\(\)/)
    expect(code).not.toMatch(/nextIndex|\.create\(/)
  })

  it('la muestra del indice sale SOLO de create().nextIndex() y nunca de la normal', () => {
    const code = read('index-sample-generation.ts')

    expect(code).toMatch(/factory\.create\(seed\)/)
    expect(code).toMatch(/nextIndex\(\)/)
    expect(code).not.toMatch(/nextNormal|createNormalSequence/)
  })

  it('el harness compone la fabrica con las clases productivas (no con copias)', () => {
    const code = read('production-factory.ts')

    expect(code).toMatch(/src\/adapters\/outbound\/system\/Mt19937BoxMullerRandomSequenceFactory/)
    expect(code).toMatch(/src\/adapters\/outbound\/system\/CdfUniformIndexMapper/)
  })

  it('el CLI genera normal e indice con modulos distintos y por ese orden de responsabilidad', () => {
    const code = read('generate-samples.ts')

    expect(code).toMatch(/generateNormalSample\(factory/)
    expect(code).toMatch(/generateIndexSample\(factory/)
    expect(code).toMatch(/createProductionRandomSequenceFactory\(\)/)
  })

  it('analyze.py lee las muestras del generador productivo; NumPy solo se usa como control de la autocomprobacion', () => {
    const python = readFileSync(join(TOOLS, 'analyze.py'), 'utf8')

    expect(python).toMatch(/np\.fromfile\(normal_path, dtype="<f8"\)/)
    // El unico generador de NumPy esta en `self_check` (controles del analisis).
    expect(python.match(/default_rng/g)).toHaveLength(1)
    expect(python.indexOf('default_rng')).toBeGreaterThan(python.indexOf('def self_check'))
    expect(python.indexOf('default_rng')).toBeLessThan(python.indexOf('def build_rows'))
  })
})
