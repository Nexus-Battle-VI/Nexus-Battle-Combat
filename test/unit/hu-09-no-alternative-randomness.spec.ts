import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guarda estatica de HU-09 (`hu-09-experience-reward-v1` §5.1, Task HU-09.2):
 * la tirada de experiencia por NPC derrotado NO puede tener una fuente de
 * aleatoriedad propia.
 *
 * `ADR-021` da la exclusiva del azar a Combat, y dentro de Combat a UNA sola
 * fuente de proceso (`BATTLE_RANDOM`, HU-24). Esta operacion es la unica puerta
 * por la que Missions pide un dado, asi que se comprueba sobre el CODIGO FUENTE
 * (sin comentarios, para que las citas del contrato no cuenten) que consume la
 * instancia inyectada y nada mas.
 */
const ROOT = join(__dirname, '..', '..', 'src')

const HU_09_SOURCES = [
  join(ROOT, 'domain', 'reward', 'ExperienceRollPolicy.ts'),
  join(ROOT, 'application', 'use-cases', 'ResolveExperienceRolls.ts'),
  join(ROOT, 'application', 'errors', 'ExperienceRollErrors.ts'),
  join(ROOT, 'application', 'ports', 'ExperienceRollRepositoryPort.ts'),
  join(ROOT, 'adapters', 'outbound', 'persistence', 'experience-roll-mapping.ts'),
  join(ROOT, 'adapters', 'outbound', 'persistence', 'MongoExperienceRollRepository.ts'),
  join(ROOT, 'adapters', 'outbound', 'persistence', 'InMemoryExperienceRollRepository.ts'),
  join(ROOT, 'adapters', 'outbound', 'persistence', 'migrations', '013-experience-rolls.ts'),
  join(ROOT, 'adapters', 'inbound', 'http', 'experience-rolls.controller.ts'),
  join(ROOT, 'adapters', 'inbound', 'http', 'experience-rolls.dto.ts'),
]

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const codeOf = (file: string): string => withoutComments(readFileSync(file, 'utf8'))

/** Cada patron es algo que HU-09 NO debe usar: otra fuente, ni su interior. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['Math.random', /Math\s*\.\s*random/],
  [
    'node:crypto / randomInt / randomBytes / getRandomValues / randomUUID',
    /node:crypto|randomInt|randomBytes|getRandomValues|randomUUID/,
  ],
  ['MT19937 (HU-24)', /Mt19937/],
  ['Box-Muller (HU-24)', /BoxMuller/],
  ['la variable normal cruda (solo HU-26)', /nextNormal|NormalSequencePort|createNormalSequence/],
  ['la semilla (HU-24)', /RandomSeed/],
  [
    'la fabrica de secuencias (la recibe ya creada el consumidor)',
    /RandomSequenceFactory|RANDOM_SEQUENCE_FACTORY/,
  ],
  ['ninguna peticion de rango distinta del dado', /nextInt\(\s*(?!EXPERIENCE_ROLL_FACES)/],
]

describe('HU-09 no usa ni conoce otra fuente de aleatoriedad', () => {
  it('vigila exactamente el codigo de HU-09 (si aparece un archivo nuevo, se revisa aqui)', () => {
    const relative = HU_09_SOURCES.map((file) => file.slice(ROOT.length + 1).replaceAll('\\', '/'))

    expect(relative.sort()).toEqual([
      'adapters/inbound/http/experience-rolls.controller.ts',
      'adapters/inbound/http/experience-rolls.dto.ts',
      'adapters/outbound/persistence/InMemoryExperienceRollRepository.ts',
      'adapters/outbound/persistence/MongoExperienceRollRepository.ts',
      'adapters/outbound/persistence/experience-roll-mapping.ts',
      'adapters/outbound/persistence/migrations/013-experience-rolls.ts',
      'application/errors/ExperienceRollErrors.ts',
      'application/ports/ExperienceRollRepositoryPort.ts',
      'application/use-cases/ResolveExperienceRolls.ts',
      'domain/reward/ExperienceRollPolicy.ts',
    ])
  })

  it.each(FORBIDDEN)('ningun archivo de HU-09 referencia %s', (_label, pattern) => {
    for (const file of HU_09_SOURCES) {
      expect({ file, matches: pattern.test(codeOf(file)) }).toEqual({ file, matches: false })
    }
  })

  it('la unica dependencia de azar de la politica es la instancia inyectada de BoundedRandom', () => {
    const code = codeOf(join(ROOT, 'domain', 'reward', 'ExperienceRollPolicy.ts'))

    expect(code).toMatch(/random\.nextInt\(EXPERIENCE_ROLL_FACES\)\s*\+\s*1/)
    expect(code).toMatch(/BoundedRandom/)
    // La politica no construye ninguna secuencia: recibe el dado ya creado.
    expect(code).not.toMatch(/createBoundedRandom|new\s+\w*Random/)
  })

  it('el caso de uso no crea su propia fuente: la recibe por constructor', () => {
    const code = codeOf(join(ROOT, 'application', 'use-cases', 'ResolveExperienceRolls.ts'))

    expect(code).toMatch(/private readonly random: BoundedRandom/)
    expect(code).not.toMatch(/createBoundedRandom|new\s+\w*Random/)
  })

  it('el dado tiene 8 caras, ni una constante de rango alternativa', () => {
    const code = codeOf(join(ROOT, 'domain', 'reward', 'ExperienceRollPolicy.ts'))

    expect(code).toMatch(/EXPERIENCE_ROLL_FACES\s*=\s*8/)
  })

  it('el contrato interno NO expone la aleatoriedad: ni semilla, ni indice, ni rango', () => {
    // `\b` en `bound`/`range` es deliberado: sin el, cualquier ruta que
    // contenga "outbound" -- que es media capa de adaptadores -- daria un falso
    // positivo.
    const exposesRandomness = /seed|nextIndex|\bbound\b|\brange\b|\bindex\b|Math\.random/i

    for (const file of [
      join(ROOT, 'adapters', 'inbound', 'http', 'experience-rolls.dto.ts'),
      join(ROOT, 'adapters', 'inbound', 'http', 'experience-rolls.controller.ts'),
    ]) {
      expect({ file, matched: exposesRandomness.exec(codeOf(file))?.[0] ?? null }).toEqual({
        file,
        matched: null,
      })
    }
  })
})
