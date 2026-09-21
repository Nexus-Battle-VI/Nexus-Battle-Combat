import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guardas estaticas de HU-18 (RF-18), sobre el CODIGO FUENTE sin comentarios: lo que
 * la HU prohibe y que una prueba de comportamiento no siempre atrapa.
 *
 *  - Ninguna otra fuente de aleatoriedad (solo `RandomSequencePort.nextIndex()`).
 *  - El ataque basico NO toca el Poder.
 *  - NO consulta a Player-Inventory ni a Catalog por golpe.
 *  - UNA sola escritura por accion (nunca "dano" y luego "fin de turno" por separado).
 *  - Nunca `Vida -= Ataque`: el Ataque solo se compara con la Defensa.
 */
const ROOT = join(__dirname, '..', '..', 'src')

const file = (path: string): string => join(ROOT, ...path.split('/'))

const HU_18_SOURCES = [
  'domain/entities/CombatProfile.ts',
  'domain/entities/Combatant.ts',
  'domain/policies/BasicAttackDamagePolicy.ts',
  'application/use-cases/ExecuteBasicAttack.ts',
  'application/services/CombatProfileFactory.ts',
  'application/ports/RoomCommandLockPort.ts',
  'adapters/inbound/ws/BasicAttackRealtimeHandler.ts',
].map(file)

/**
 * HU-19 amplia `CombatProfile`, `Combatant` y `CombatProfileFactory` con el Poder maximo, el Poder
 * actual, las recargas y las habilidades (contrato `hu-19-skills-v1`, §5): dejan de poder afirmar
 * que no mencionan Poder. La regla que esta guarda protege -- el ataque basico NO consume Poder --
 * sigue intacta para todo lo que ES el ataque basico, y ademas se comprueba por comportamiento
 * (`hu-19-skills.behavior.spec.ts`: el Poder del atacante no cambia tras un `attack`).
 */
const HU_18_ATTACK_SOURCES = [
  'domain/policies/BasicAttackDamagePolicy.ts',
  'application/use-cases/ExecuteBasicAttack.ts',
  'application/ports/RoomCommandLockPort.ts',
  'adapters/inbound/ws/BasicAttackRealtimeHandler.ts',
].map(file)

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const code = (path: string): string => withoutComments(readFileSync(path, 'utf8'))

describe('HU-18 — aleatoriedad', () => {
  it.each([
    ['Math.random', /Math\s*\.\s*random/],
    [
      'node:crypto / randomInt / randomBytes / getRandomValues / randomUUID',
      /node:crypto|from 'crypto'|randomInt|randomBytes|getRandomValues|randomUUID/,
    ],
    ['reloj como fuente (Date.now)', /Date\s*\.\s*now/],
    ['MT19937 propio', /Mt19937|Mersenne/i],
    ['Box-Muller propio', /BoxMuller/],
    ['la semilla', /RandomSeed|randomSeed/],
    ['la fabrica de secuencias', /RandomSequenceFactory|RANDOM_SEQUENCE_FACTORY/],
  ])('ningun archivo de HU-18 referencia %s', (_label, pattern) => {
    for (const source of HU_18_SOURCES) {
      expect({ source, matches: pattern.test(code(source)) }).toEqual({ source, matches: false })
    }
  })

  it('el caso de uso sortea SOLO por RandomSequencePort.nextIndex()', () => {
    const source = code(file('application/use-cases/ExecuteBasicAttack.ts'))

    expect(source).toMatch(/this\.sequence\.nextIndex\(\)/)
    expect(source).toMatch(/dieFaceFromIndex/)
    // El dado de Dano reutiliza la misma conversion de indice a cara que el dado de Ataque.
    expect(source).not.toMatch(/Math\./)
  })

  it('no hay un segundo algoritmo de dado: la cara sale de dieFaceFromIndex (HU-20)', () => {
    for (const source of HU_18_SOURCES) {
      expect(code(source)).not.toMatch(/\*\s*sides\s*\/\s*8000|8000\s*\/\s*sides/)
    }
  })
})

describe('HU-18 — el ataque basico NO consume Poder', () => {
  it.each(['consumePower', 'spendPower', 'decreasePower', 'currentPower', 'HeroPower', 'power'])(
    'ningun archivo del ataque basico usa `%s`',
    (token) => {
      const pattern = new RegExp(`\\b${token}\\b`, 'i')

      for (const source of HU_18_ATTACK_SOURCES) {
        expect({ source, matches: pattern.test(code(source)) }).toEqual({ source, matches: false })
      }
    },
  )

  it('la validacion del dominio no menciona Poder', () => {
    const room = code(file('domain/entities/BattleRoom.ts'))
    const attackSection = room.slice(
      room.indexOf('planBasicAttack'),
      room.indexOf('assertValidCommandId'),
    )

    expect(attackSection).not.toMatch(/power/i)
  })
})

describe('HU-18 — sin llamadas cruzadas por golpe', () => {
  it.each([
    ['PlayerInventoryEquippedHeroPort', /PlayerInventoryEquippedHero/],
    ['AccountBattleProfilePort', /AccountBattleProfile/],
    ['clientes HTTP de otros servicios', /adapters\/outbound\/http|HttpClient/],
    ['Catalog', /catalog/i],
  ])('ExecuteBasicAttack no depende de %s', (_label, pattern) => {
    expect(code(file('application/use-cases/ExecuteBasicAttack.ts'))).not.toMatch(pattern)
  })

  it('el perfil se toma del snapshot de la sala, no de un puerto', () => {
    const source = code(file('application/use-cases/ExecuteBasicAttack.ts'))

    expect(source).toMatch(/plan\.attackerProfile/)
    expect(source).toMatch(/plan\.targetProfile/)
  })
})

describe('HU-18 — una sola escritura y ninguna resta de Ataque', () => {
  it('ExecuteBasicAttack guarda UNA vez y no invoca CompleteBattleTurn como segundo save', () => {
    const source = code(file('application/use-cases/ExecuteBasicAttack.ts'))
    const saves = source.match(/\.save\(/g) ?? []

    expect(saves).toHaveLength(1)
    expect(source).not.toMatch(/CompleteBattleTurn|completeTurn\(/)
  })

  it('la Vida, el evento, el commandId y el turno se aplican en el agregado (applyBasicAttack)', () => {
    const room = code(file('domain/entities/BattleRoom.ts'))
    const apply = room.slice(
      room.indexOf('applyBasicAttack('),
      room.indexOf('private static assertValidCommandId'),
    )

    expect(apply).toMatch(/withCombatant\(/)
    expect(apply).toMatch(/\.completeTurn\(\)/)
    expect(apply).toMatch(/handledCommands: \[\.\.\.this\.handledCommands/)
    expect(apply).toMatch(/BattleEventType\.BasicAttackResolved/)
  })

  it('el Ataque nunca es el dano: no se resta ni se descuenta de la Vida', () => {
    const policy = code(file('domain/policies/BasicAttackDamagePolicy.ts'))
    const room = code(file('domain/entities/BattleRoom.ts'))
    const useCase = code(file('application/use-cases/ExecuteBasicAttack.ts'))

    for (const source of [policy, room, useCase]) {
      expect(source).not.toMatch(/attackValue\s*-\s*(defenseValue|defense)/)
      expect(source).not.toMatch(/(health|Health)\w*\s*-=\s*attack/i)
      expect(source).not.toMatch(/healthAfter\s*[:=]\s*[^,\n]*attackValue/)
    }
  })

  it('el redondeo es floor y no round ni ceil (aclaracion formal de Management #62)', () => {
    const policy = code(file('domain/policies/BasicAttackDamagePolicy.ts'))

    expect(policy).toMatch(/Math\.floor\(/)
    expect(policy).not.toMatch(/Math\.(round|ceil)\(/)
  })
})

describe('HU-18 — el cliente no aporta resultados', () => {
  it('el comando solo admite type, commandId, roomId y target', () => {
    const handler = code(file('adapters/inbound/ws/BasicAttackRealtimeHandler.ts'))

    expect(handler).toMatch(/\['type', 'commandId', 'roomId', 'target'\]/)
    expect(handler).toMatch(/\['teamLabel', 'seat'\]/)
  })

  it('el atacante sale del sub autenticado que recibe el handler, no del mensaje', () => {
    const handler = code(file('adapters/inbound/ws/BasicAttackRealtimeHandler.ts'))

    expect(handler).toMatch(/requesterId: subject/)
    expect(handler).not.toMatch(/message\.attacker|command\.attacker/)
  })
})
