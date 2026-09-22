import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Guardas estaticas de HU-23 (RF-23), sobre el CODIGO FUENTE sin comentarios:
 * lo que la historia prohibe y que una prueba de comportamiento no atrapa
 * siempre.
 *
 *  - Nada de aleatoriedad ni reloj propio en dominio/aplicacion de la apuesta:
 *    el tiempo sale de `ClockPort` y los `operationId` son deterministas.
 *  - El literal `battle:` (formato de `operationId`) NO aparece en el dominio:
 *    lo resuelve la aplicacion (`StakeOperationIds`), nunca el agregado.
 *  - La ruta interna de Wallet (`/api/internal/v1/wallet/stakes/...`) vive en
 *    un unico cliente HTTP.
 *  - El dominio y la aplicacion no conocen adaptadores ni `fetch`.
 */
const ROOT = join(__dirname, '..', '..', 'src')

const file = (path: string): string => join(ROOT, ...path.split('/'))

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const code = (path: string): string => withoutComments(readFileSync(path, 'utf8'))

/** Archivos de HU-23 en dominio y aplicacion (los que deben ser puros). */
const HU_23_CORE = [
  'domain/value-objects/ParticipantStake.ts',
  'domain/policies/BattleStakePolicy.ts',
  'application/services/StakeOperationIds.ts',
  'application/services/StakeReserver.ts',
  'application/services/StakeReleaser.ts',
  'application/services/StakeSettler.ts',
  'application/use-cases/ReconcileStakes.ts',
].map(file)

const allSources = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)

    if (statSync(path).isDirectory()) {
      return allSources(path)
    }

    return path.endsWith('.ts') ? [path] : []
  })

describe('HU-23 — sin aleatoriedad ni reloj propio en la apuesta', () => {
  it.each([
    ['Math.random', /Math\s*\.\s*random/],
    ['node:crypto / randomUUID', /node:crypto|randomUUID|randomBytes/],
    ['Date.now()', /Date\s*\.\s*now\s*\(/],
  ])('ningun archivo nuevo de la apuesta referencia %s', (_label, pattern) => {
    for (const source of HU_23_CORE) {
      expect({ source, matches: pattern.test(code(source)) }).toEqual({ source, matches: false })
    }
  })

  it('`new Date(` solo aparece en ReconcileStakes, desplazando el instante del reloj', () => {
    for (const source of HU_23_CORE) {
      const matches = code(source).includes('new Date(')

      if (source.endsWith('ReconcileStakes.ts')) {
        expect(matches).toBe(true)
        expect(code(source)).toMatch(/new Date\(this\.clock\.now\(\)\.getTime\(\) -/)
      } else {
        expect({ source, matches }).toEqual({ source, matches: false })
      }
    }
  })

  it('el dominio no construye `operationId` (`battle:` como literal de id no aparece en src/domain)', () => {
    const offenders = allSources(join(ROOT, 'domain'))
      .filter((path) => /battle:\$\{|['"`]battle:/.test(code(path)))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))

    expect(offenders).toEqual([])
  })

  it('la ruta interna de apuestas vive en un unico cliente HTTP', () => {
    const offenders = allSources(ROOT)
      .filter((path) => code(path).includes('/api/internal/v1/wallet/stakes'))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))

    expect(offenders).toEqual(['adapters/outbound/http/WalletStakeHttpClient.ts'])
  })

  it('ni el dominio ni la aplicacion usan `fetch` ni `process.env`', () => {
    for (const path of allSources(join(ROOT, 'domain')).concat(
      allSources(join(ROOT, 'application')),
    )) {
      const source = code(path)

      expect({ path, matches: /[^a-zA-Z]fetch\s*\(/.test(source) }).toEqual({
        path,
        matches: false,
      })
      expect({ path, matches: source.includes('process.env') }).toEqual({ path, matches: false })
    }
  })
})
