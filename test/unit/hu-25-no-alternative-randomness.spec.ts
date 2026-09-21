import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guarda estatica de RF-25 / CA-07: HU-25 y HU-20 no pueden seleccionar efectos
 * (ni lanzar el dado de Ataque) con una fuente de aleatoriedad distinta del
 * generador centralizado (HU-24), ni conocer su interior. Se comprueba sobre el
 * CODIGO FUENTE (sin comentarios) para que un uso accidental futuro falle en CI.
 */
const ROOT = join(__dirname, '..', '..', 'src')

const HU_25_SOURCES = [
  ...readdirSync(join(ROOT, 'domain', 'random-effects')).map((file) =>
    join(ROOT, 'domain', 'random-effects', file),
  ),
  join(ROOT, 'domain', 'errors', 'RandomEffectErrors.ts'),
  join(ROOT, 'domain', 'value-objects', 'HeroSubtype.ts'),
  join(ROOT, 'application', 'use-cases', 'ResolveRandomEffect.ts'),
  join(ROOT, 'application', 'use-cases', 'BuildHeroEffectTable.ts'),
  // HU-20: la resolucion de un golpe (dado de Ataque incluido) tampoco puede tener otra fuente.
  join(ROOT, 'application', 'use-cases', 'PrepareAttack.ts'),
  join(ROOT, 'application', 'use-cases', 'ResolveAttack.ts'),
  join(ROOT, 'domain', 'errors', 'AttackResolutionErrors.ts'),
  join(ROOT, 'domain', 'policies', 'AttackProfile.ts'),
  join(ROOT, 'domain', 'policies', 'AttackResolutionPolicy.ts'),
]

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Cada patron es algo que HU-25 NO debe usar ni conocer. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['Math.random', /Math\s*\.\s*random/],
  [
    'node:crypto / randomInt / randomBytes / getRandomValues',
    /node:crypto|randomInt|randomBytes|getRandomValues|randomUUID/,
  ],
  ['MT19937 (HU-24)', /Mt19937/],
  ['Box-Muller (HU-24)', /BoxMuller/],
  ['CDF normal (HU-24)', /StandardNormalCdf|standardNormalCdf/],
  ['la variable normal cruda (solo HU-26)', /nextNormal|NormalSequencePort|createNormalSequence/],
  ['la semilla (HU-24)', /RandomSeed/],
  [
    'la fabrica de secuencias (la recibe ya creada el consumidor)',
    /RandomSequenceFactory|RANDOM_SEQUENCE_FACTORY/,
  ],
  ['adaptadores o infraestructura', /adapters\/|infrastructure\//],
  ['NestJS', /@nestjs\//],
]

describe('HU-25 y HU-20 no usan ni conocen otra fuente de aleatoriedad', () => {
  it('vigila exactamente el codigo de HU-25 y HU-20 (si aparece un archivo nuevo, se revisa aqui)', () => {
    const relative = HU_25_SOURCES.map((file) => file.slice(ROOT.length + 1).replaceAll('\\', '/'))

    expect(relative.sort()).toEqual([
      'application/use-cases/BuildHeroEffectTable.ts',
      'application/use-cases/PrepareAttack.ts',
      'application/use-cases/ResolveAttack.ts',
      'application/use-cases/ResolveRandomEffect.ts',
      'domain/errors/AttackResolutionErrors.ts',
      'domain/errors/RandomEffectErrors.ts',
      'domain/policies/AttackProfile.ts',
      'domain/policies/AttackResolutionPolicy.ts',
      'domain/random-effects/BaseEffectProfiles.ts',
      'domain/random-effects/EffectControlTable.ts',
      'domain/random-effects/EffectMagnitude.ts',
      'domain/random-effects/ProbabilityModifier.ts',
      'domain/random-effects/RandomEffectType.ts',
      'domain/random-effects/ResolvedRandomEffect.ts',
      'domain/value-objects/HeroSubtype.ts',
    ])
  })

  it.each(FORBIDDEN)('ningun archivo de HU-25 ni de HU-20 referencia %s', (_label, pattern) => {
    for (const file of HU_25_SOURCES) {
      const code = withoutComments(readFileSync(file, 'utf8'))

      expect({ file, matches: pattern.test(code) }).toEqual({ file, matches: false })
    }
  })

  it('la unica dependencia de aleatoriedad del caso de uso es RandomSequencePort.nextIndex()', () => {
    const code = withoutComments(
      readFileSync(join(ROOT, 'application', 'use-cases', 'ResolveRandomEffect.ts'), 'utf8'),
    )

    expect(code).toMatch(/nextIndex\(\)/)
    expect(code).toMatch(/RandomSequencePort/)
  })

  it('el dado de Ataque y el efecto de HU-20 salen SOLO de RandomSequencePort.nextIndex()', () => {
    const code = withoutComments(
      readFileSync(join(ROOT, 'application', 'use-cases', 'ResolveAttack.ts'), 'utf8'),
    )

    expect(code).toMatch(/sequence\.nextIndex\(\)/)
    expect(code).toMatch(/RandomSequencePort/)
    expect(code).toMatch(/ResolveRandomEffect/)
    // Ninguna otra llamada a un generador: el dado usa el indice, no un aleatorio propio.
    expect(code).not.toMatch(/random\s*\(/i)
  })
})
