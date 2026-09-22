import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Guardas estaticas de HU-21 (RF-21), sobre el CODIGO FUENTE sin comentarios: lo
 * que la historia prohibe y que una prueba de comportamiento no atrapa siempre.
 *
 *  - Nada de aleatoriedad ni reloj propio en dominio/aplicacion: el tiempo sale
 *    de `ClockPort` y la unica construccion de fechas derivadas vive en
 *    `BattleTimingPolicy` (`new Date(x.getTime() + ms)`).
 *  - `setInterval`/`setTimeout` solo en el planificador nuevo y en los dos
 *    adaptadores que ya los tenian.
 *  - `rooms.save(` una vez en cada accion y en el `Settler`; cero en los casos
 *    de uso y servicios que solo liquidan.
 *  - `.finish(` solo desde el agregado.
 *  - `afterFinished(` solo desde el `Settler` y los handlers, y SIEMPRE despues
 *    de `publish(`; jamas desde los casos de uso.
 *  - Los tiempos no se configuran por entorno.
 *  - El mensaje del cliente no aporta ganador, causa ni tiempos.
 *  - Ningun adaptador de entrada menciona creditos ni wallet.
 */
const ROOT = join(__dirname, '..', '..', 'src')

const file = (path: string): string => join(ROOT, ...path.split('/'))

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const code = (path: string): string => withoutComments(readFileSync(path, 'utf8'))

/** Archivos nuevos de HU-21 en dominio y aplicacion (los del reloj/azar). */
const HU_21_CORE = [
  'domain/policies/BattleTimingPolicy.ts',
  'domain/policies/BattleOutcomePolicy.ts',
  'domain/policies/BattleCreditsPolicy.ts',
  'domain/entities/BattleResult.ts',
  'domain/entities/BattleRoom.ts',
  'domain/entities/BattleState.ts',
  'domain/entities/BattleEvent.ts',
  'application/services/BattleFinalizer.ts',
  'application/services/BattleDeadlineSettler.ts',
  'application/use-cases/ExecuteBasicAttack.ts',
  'application/use-cases/UseSkill.ts',
  'application/use-cases/StartBattle.ts',
  'application/use-cases/ProcessBattleDeadlines.ts',
  'application/use-cases/RecoverBattleDeadlines.ts',
  'application/dto/BattleEventDto.ts',
].map(file)

const allSources = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)

    if (statSync(path).isDirectory()) {
      return allSources(path)
    }

    return path.endsWith('.ts') ? [path] : []
  })

describe('HU-21 — sin aleatoriedad ni reloj propio en dominio/aplicacion', () => {
  it.each([
    ['Math.random', /Math\s*\.\s*random/],
    [
      'node:crypto / randomInt / randomBytes / randomUUID',
      /node:crypto|randomInt|randomBytes|randomUUID/,
    ],
    ['Date.now()', /Date\s*\.\s*now\s*\(/],
  ])('ningun archivo nuevo referencia %s', (_label, pattern) => {
    for (const source of HU_21_CORE) {
      expect({ source, matches: pattern.test(code(source)) }).toEqual({ source, matches: false })
    }
  })

  it('`new Date(` solo aparece en BattleTimingPolicy (desplazamiento de una fecha YA recibida)', () => {
    for (const source of HU_21_CORE) {
      const matches = code(source).includes('new Date(')

      if (source.endsWith('BattleTimingPolicy.ts')) {
        expect(matches).toBe(true)
      } else {
        expect({ source, matches }).toEqual({ source, matches: false })
      }
    }
  })

  it('los tiempos son constantes del dominio: `process.env` no aparece en la politica', () => {
    const policy = code(file('domain/policies/BattleTimingPolicy.ts'))

    expect(policy).not.toMatch(/process\.env/)
    expect(policy).toMatch(/BATTLE_TIME_LIMIT_MS = 360_000/)
    expect(policy).toMatch(/TURN_TIME_LIMIT_MS = 30_000/)
    expect(policy).toMatch(/DISCONNECT_GRACE_MS = 30_000/)
  })
})

describe('HU-21 — temporizadores y un solo escritor', () => {
  it('`setInterval`/`setTimeout` solo en el planificador nuevo y en los dos adaptadores que ya los tenian', () => {
    const withTimers = allSources(ROOT)
      .filter((path) => /setInterval|setTimeout/.test(code(path)))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))
      .sort()

    expect(withTimers).toEqual([
      'adapters/inbound/ws/BattleRoomRealtimeGateway.ts',
      'adapters/outbound/http/InternalHttpClient.ts',
      'adapters/outbound/system/IntervalBattleDeadlineScheduler.ts',
    ])
  })

  it.each([
    ['application/use-cases/ExecuteBasicAttack.ts', 1],
    ['application/use-cases/UseSkill.ts', 1],
    ['application/services/BattleDeadlineSettler.ts', 1],
    ['application/use-cases/ProcessBattleDeadlines.ts', 0],
    ['application/services/BattleFinalizer.ts', 0],
    ['application/use-cases/RecoverBattleDeadlines.ts', 0],
  ])('%s llama a `rooms.save(` exactamente %i vez/veces', (path, expected) => {
    const saves = code(file(path)).match(/\.save\(/g) ?? []

    expect(saves).toHaveLength(expected)
  })

  it('`.finish(` solo se invoca desde el agregado (BattleRoom)', () => {
    const callers = allSources(ROOT)
      .filter((path) => code(path).includes('.finish('))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))

    expect(callers).toEqual(['domain/entities/BattleRoom.ts'])
  })

  it('`afterFinished(` solo desde el Settler y los handlers, y SIEMPRE despues de `publish(`', () => {
    const callers = allSources(ROOT)
      .filter((path) => code(path).includes('.afterFinished('))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))
      .sort()

    expect(callers).toEqual([
      'adapters/inbound/ws/BasicAttackRealtimeHandler.ts',
      'adapters/inbound/ws/SkillRealtimeHandler.ts',
      'application/services/BattleDeadlineSettler.ts',
    ])

    for (const path of callers) {
      const source = code(file(path))
      // `Settler` publica a traves de su helper `publishNewEvents`; los handlers
      // lo hacen con el `publish` que reciben. En ambos casos, la PRIMERA
      // mencion de publicar precede a `afterFinished`.
      const publishIndex = source.search(/publish(NewEvents)?\(/)

      expect(publishIndex).toBeGreaterThan(-1)
      expect(publishIndex).toBeLessThan(source.indexOf('afterFinished('))
    }

    for (const path of [
      'application/use-cases/ExecuteBasicAttack.ts',
      'application/use-cases/UseSkill.ts',
    ]) {
      expect(code(file(path))).not.toMatch(/afterFinished\(/)
    }
  })
})

describe('HU-21 — el cliente no aporta el resultado y los adaptadores no acreditan', () => {
  it.each([
    'adapters/inbound/ws/BasicAttackRealtimeHandler.ts',
    'adapters/inbound/ws/SkillRealtimeHandler.ts',
  ])('%s no lee ganador, causa ni tiempos del mensaje', (path) => {
    const handler = code(file(path))

    expect(handler).not.toMatch(/message\.(winner|result|reason|deadline|timeout)/i)
  })

  it('los casos de uso no reciben ganador, causa ni instantes del cliente', () => {
    for (const path of [
      'application/use-cases/ExecuteBasicAttack.ts',
      'application/use-cases/UseSkill.ts',
    ]) {
      const useCase = code(file(path))

      expect(useCase).not.toMatch(/input\.(winner|result|reason|deadline|timeout)/i)
    }
  })

  it('ningun adaptador de entrada menciona wallet ni creditos (el derecho sale por el puerto)', () => {
    for (const path of allSources(join(ROOT, 'adapters', 'inbound'))) {
      expect({ path, matches: /wallet|credit/i.test(code(path)) }).toEqual({ path, matches: false })
    }
  })
})
