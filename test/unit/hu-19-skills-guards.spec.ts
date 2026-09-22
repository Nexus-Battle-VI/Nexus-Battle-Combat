import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guardas estaticas de HU-19 (RF-19), sobre el CODIGO FUENTE sin comentarios: lo que la HU
 * prohibe y que una prueba de comportamiento no siempre atrapa.
 *
 *  - Ninguna otra fuente de aleatoriedad (solo `RandomSequencePort.nextIndex()`).
 *  - NO consulta a Player-Inventory ni a Catalog por accion: todo sale del snapshot congelado.
 *  - UNA sola escritura por accion (nunca "Poder" y luego "fin de turno" por separado).
 *  - El cliente no aporta Poder, costo, recarga, efectos, bono ni resultado.
 *  - El Poder se cobra y se regenera SOLO con la politica de HU-11 (`HeroPowerPolicy`).
 */
const ROOT = join(__dirname, '..', '..', 'src')

const file = (path: string): string => join(ROOT, ...path.split('/'))

const HU_19_SOURCES = [
  'domain/policies/SkillEffectPolicy.ts',
  'application/use-cases/UseSkill.ts',
  'adapters/inbound/ws/SkillRealtimeHandler.ts',
].map(file)

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const code = (path: string): string => withoutComments(readFileSync(path, 'utf8'))

describe('HU-19 — aleatoriedad', () => {
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
  ])('ningun archivo de HU-19 referencia %s', (_label, pattern) => {
    for (const source of HU_19_SOURCES) {
      expect({ source, matches: pattern.test(code(source)) }).toEqual({ source, matches: false })
    }
  })

  it('UseSkill sortea SOLO por RandomSequencePort.nextIndex() y la cara sale de dieFaceFromIndex (HU-20)', () => {
    const source = code(file('application/use-cases/UseSkill.ts'))

    expect(source).toMatch(/this\.sequence\.nextIndex\(\)/)
    expect(source).toMatch(/dieFaceFromIndex/)
    expect(source).not.toMatch(/Math\./)
    expect(source).not.toMatch(/\*\s*sides\s*\/\s*8000|8000\s*\/\s*sides/)
  })

  it('los dados del bono de Ataque se tiran ANTES de invocar ResolveAttack (orden del contrato §4.2)', () => {
    const source = code(file('application/use-cases/UseSkill.ts'))
    const resolve = source.slice(
      source.indexOf('private resolve('),
      source.indexOf('private materializeDamage('),
    )

    expect(resolve.indexOf('this.roll(plan.attackBonus.dice)')).toBeGreaterThan(-1)
    expect(resolve.indexOf('this.roll(plan.attackBonus.dice)')).toBeLessThan(
      resolve.indexOf('this.resolveAttack.execute'),
    )
  })

  it('el dado de Dano del heroe se tira ANTES que los dados del bono de Dano (§4.2, pasos 4 y 5)', () => {
    const source = code(file('application/use-cases/UseSkill.ts'))
    const damage = source.slice(
      source.indexOf('private materializeDamage('),
      source.indexOf('private roll('),
    )

    const heroRoll = damage.indexOf('this.roll([{ count: plan.damage.count')
    const bonusRoll = damage.indexOf('this.roll(plan.damageBonus.dice)')

    expect(heroRoll).toBeGreaterThan(-1)
    expect(bonusRoll).toBeGreaterThan(-1)
    expect(heroRoll).toBeLessThan(bonusRoll)
  })
})

describe('HU-19 — el Poder solo se maneja con la politica de HU-11', () => {
  it('el agregado cobra el Poder con spendPower (HeroPowerPolicy), no con una resta propia', () => {
    const room = code(file('domain/entities/BattleRoom.ts'))
    const plan = room.slice(room.indexOf('planSkill('), room.indexOf('applySkill('))

    expect(room).toMatch(/import \{ spendPower \} from '\.\.\/policies\/HeroPowerPolicy'/)
    expect(plan).toMatch(/spendPower\(/)
    expect(plan).not.toMatch(/currentPower\s*-|power\s*-=|Power\s*-\s*\w*[cC]ost/)
  })

  it('el Combatant regenera con regenPower (RF-11, +2 con tope), sin repetir el numero', () => {
    const combatant = code(file('domain/entities/Combatant.ts'))

    expect(combatant).toMatch(/regenPower\(/)
    expect(combatant).not.toMatch(/currentPower\s*\+\s*2|Math\.min\(/)
  })

  it('la politica de efectos es pura: no importa nada mas que tipos y una constante, y no sortea', () => {
    const policy = readFileSync(file('domain/policies/SkillEffectPolicy.ts'), 'utf8')
    const imports = policy.match(/^import .*$/gm) ?? []

    // HU-12 (excepcion de curacion, sin Task de Management): `MAX_HEALING_BASIS_POINTS`
    // es una constante numerica (sin I/O, sin aleatoriedad) de `HealApplicationPolicy`,
    // otra politica igual de pura -- no rompe "no importa nada mas que tipos y no sortea".
    expect(imports).toEqual([
      "import type { CombatAbility, CombatAbilityEffect, CombatMagnitude } from '../entities/CombatProfile'",
      "import { MAX_HEALING_BASIS_POINTS } from './HealApplicationPolicy'",
    ])
  })
})

describe('HU-19 — sin llamadas cruzadas por accion', () => {
  it.each([
    ['PlayerInventoryEquippedHeroPort', /PlayerInventoryEquippedHero/],
    ['AccountBattleProfilePort', /AccountBattleProfile/],
    ['clientes HTTP de otros servicios', /adapters\/outbound\/http|HttpClient/],
    ['Catalog', /catalog/i],
  ])('UseSkill no depende de %s', (_label, pattern) => {
    expect(code(file('application/use-cases/UseSkill.ts'))).not.toMatch(pattern)
  })

  it('la habilidad, su costo y su recarga se toman del snapshot de la sala, no de un puerto', () => {
    const source = code(file('application/use-cases/UseSkill.ts'))

    expect(source).toMatch(/plan\.attackerProfile/)
    expect(source).toMatch(/plan\.targetProfile/)
    expect(source).toMatch(/plan\.attackBonus/)
    expect(source).toMatch(/plan\.damageBonus/)
  })
})

describe('HU-19 — una sola escritura', () => {
  it('UseSkill guarda UNA vez y no invoca CompleteBattleTurn como segundo save', () => {
    const source = code(file('application/use-cases/UseSkill.ts'))
    const saves = source.match(/\.save\(/g) ?? []

    expect(saves).toHaveLength(1)
    expect(source).not.toMatch(/CompleteBattleTurn|completeTurn\(/)
  })

  it('el Poder, la recarga, la Vida, el evento, el commandId y el turno se aplican juntos en applySkill', () => {
    const room = code(file('domain/entities/BattleRoom.ts'))
    const apply = room.slice(
      room.indexOf('applySkill('),
      room.indexOf('private static assertValidCommandId'),
    )

    expect(apply).toMatch(/\.withPower\(/)
    expect(apply).toMatch(/\.withCooldown\(/)
    expect(apply).toMatch(/\.withCombatant\(/)
    // HU-21: el avance recibe el instante del servidor (`completeTurn(at)`).
    expect(apply).toMatch(/\.completeTurn\(at\)/)
    expect(apply).toMatch(/handledCommands: \[\.\.\.this\.handledCommands/)
    expect(apply).toMatch(/BattleEventType\.SkillUsed/)
  })

  it('la ruta de la habilidad NO resta el Ataque de la Vida', () => {
    for (const path of ['application/use-cases/UseSkill.ts', 'domain/entities/BattleRoom.ts']) {
      const source = code(file(path))

      expect(source).not.toMatch(/attackValue\s*-\s*(defenseValue|defense)/)
      expect(source).not.toMatch(/(health|Health)\w*\s*-=\s*attack/i)
    }
  })
})

describe('HU-19 — el cliente no aporta resultados', () => {
  it('el comando solo admite type, commandId, roomId, abilityId y target', () => {
    const handler = code(file('adapters/inbound/ws/SkillRealtimeHandler.ts'))

    expect(handler).toMatch(/\['type', 'commandId', 'roomId', 'abilityId', 'target'\]/)
    expect(handler).toMatch(/\['teamLabel', 'seat'\]/)
  })

  it('el actor sale del sub autenticado que recibe el handler, no del mensaje', () => {
    const handler = code(file('adapters/inbound/ws/SkillRealtimeHandler.ts'))

    expect(handler).toMatch(/requesterId: subject/)
    expect(handler).not.toMatch(/message\.(actor|attacker|heroId)|command\.(actor|attacker)/)
  })

  it('el caso de uso solo recibe roomId, requesterId, commandId, abilityId y target', () => {
    const useCase = code(file('application/use-cases/UseSkill.ts'))
    const input = useCase.slice(
      useCase.indexOf('export interface UseSkillInput'),
      useCase.indexOf('export interface UseSkillResult'),
    )
    const fields = [...input.matchAll(/readonly (\w+):/g)].map((match) => match[1])

    expect(fields).toEqual(['roomId', 'requesterId', 'commandId', 'abilityId', 'target'])
  })

  it('el Poder insuficiente en una habilidad OFENSIVA no tiene codigo de error propio: se degrada (HU-11)', () => {
    const errors = code(file('domain/errors/BattleErrors.ts'))

    // HU-12 (excepcion de curacion, sin Task de Management): un sanador no tiene
    // Ataque numerico y no puede degradar a ataque basico (Tabla 6), asi que ESE
    // caso SI tiene codigo propio (`INSUFFICIENT_POWER_FOR_HEAL`). Lo que sigue
    // sin codigo es el Poder insuficiente de una habilidad ofensiva: no debe
    // aparecer ningun OTRO codigo de "Poder insuficiente" ademas del de curar.
    const insufficientPowerCodes = [...errors.matchAll(/INSUFFICIENT_POWER\w*/g)].map(
      (match) => match[0],
    )

    expect(new Set(insufficientPowerCodes)).toEqual(new Set(['INSUFFICIENT_POWER_FOR_HEAL']))
  })

  it('el motivo de un efecto no soportado no viaja al cliente (solo se registra)', () => {
    const handler = code(file('adapters/inbound/ws/SkillRealtimeHandler.ts'))
    const reject = handler.slice(handler.indexOf('private reject('))

    expect(reject).not.toMatch(/reason/)
  })
})

describe('HU-19 — la habilidad no cruza la frontera con la epica ni inventa su estado (HU-31)', () => {
  it('ningun archivo de HU-19 declara activeEpic, epicSlot ni equivalentes', () => {
    for (const source of [
      ...HU_19_SOURCES,
      file('domain/entities/CombatProfile.ts'),
      file('domain/entities/Combatant.ts'),
    ]) {
      expect({
        source,
        matches: /activeEpic|epicSlot|selectedEpic|equippedEpic|epicId/i.test(code(source)),
      }).toEqual({ source, matches: false })
    }
  })
})
