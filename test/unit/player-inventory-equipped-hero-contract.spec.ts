import 'reflect-metadata'

import { PlayerInventoryHttpClient } from '../../src/adapters/outbound/http/PlayerInventoryHttpClient'
import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type { EquippedHero } from '../../src/application/ports/PlayerInventoryEquippedHeroPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { HERO_SUBTYPES } from '../../src/domain/value-objects/HeroSubtype'
import type { Logger } from '../../src/infrastructure/observability/logger'
import {
  attackBonusEffect,
  conditionalDefenseEffect,
  criticalChancePercentageEffect,
  equippedHeroContractBody,
  equippedHeroFixture,
  opponentDamageDiceEffect,
} from '../fixtures/equipped-hero'

/**
 * Parser estricto del contrato `equipped-hero` de Player-Inventory (HU-25,
 * HU-15.2). `fetchImpl` se inyecta: nunca se golpea una red real. Cada caso
 * fija UN aspecto del contrato, y todo lo malformado debe terminar en
 * `UpstreamServiceError` (503), no en un `TypeError` crudo ni en un valor
 * inventado.
 */
const NOW = new Date('2026-09-19T10:00:00.000Z')
const clock: ClockPort = { now: () => NOW }
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as unknown as Response

const clientReturning = (status: number, body: unknown): PlayerInventoryHttpClient =>
  new PlayerInventoryHttpClient({
    baseUrl: 'https://player-inventory.internal',
    callerService: 'combat',
    secret: 'secreto-compartido-de-pruebas',
    clock,
    logger: silentLogger,
    fetchImpl: () => Promise.resolve(jsonResponse(status, body)),
  })

const fetchHero = (body: unknown): Promise<EquippedHero | null> =>
  clientReturning(200, body).getEquippedHero('jugador-1')

const expectRejected = async (body: unknown): Promise<void> => {
  const outcome = fetchHero(body)

  await expect(outcome).rejects.toBeInstanceOf(UpstreamServiceError)
  await expect(outcome).rejects.toMatchObject({
    service: 'player-inventory',
    reason: 'respuesta_invalida',
  })
}

const bodyWithEffects = (activeEffects: unknown): Record<string, unknown> =>
  equippedHeroContractBody({ activeEffects })

/** Un efecto valido con un campo cambiado (o retirado si el valor es `undefined`). */
const effectWith = (change: Record<string, unknown>): Record<string, unknown> => ({
  ...criticalChancePercentageEffect,
  ...change,
})

const statsWith = (change: Record<string, unknown>): Record<string, unknown> => ({
  ...(equippedHeroContractBody().baseStats as Record<string, unknown>),
  ...change,
})

describe('PlayerInventoryHttpClient — contrato completo (HU-25)', () => {
  it('un contrato completo y valido llega al puerto tal cual, con maxPower = effectiveStats.power', async () => {
    const hero = await fetchHero(equippedHeroContractBody())

    expect(hero).toEqual(equippedHeroFixture())
    expect(hero?.maxPower).toBe(hero?.effectiveStats.power)
  })

  it.each(HERO_SUBTYPES)('el subtipo %s viaja sin modificar', async (subtype) => {
    await expect(fetchHero(equippedHeroContractBody({ subtype }))).resolves.toMatchObject({
      subtype,
    })
  })

  it('NO valida el vocabulario de subtipos: uno nuevo no bloquea el ingreso a sala (se valida al construir la tabla)', async () => {
    await expect(
      fetchHero(equippedHeroContractBody({ subtype: 'HEROE_DE_UN_SUBTIPO_NUEVO' })),
    ).resolves.toMatchObject({ subtype: 'HEROE_DE_UN_SUBTIPO_NUEVO' })
  })

  it('las estadisticas base y efectivas se conservan por separado', async () => {
    const hero = await fetchHero(equippedHeroContractBody())

    expect(hero?.baseStats.attack).toBe(10)
    expect(hero?.effectiveStats.attack).toBe(13)
    expect(hero?.baseStats.damage).toEqual({ mode: 'DICE', count: 1, sides: 4 })
    expect(hero?.baseStats.healing).toBeNull()
  })

  it('un heroe sin ataque fijo ni dano (attack, damage y healing a null) es valido', async () => {
    const sanador = statsWith({ attack: null, damage: null, healing: { mode: 'FIXED', amount: 4 } })

    await expect(
      fetchHero(equippedHeroContractBody({ baseStats: sanador, effectiveStats: sanador })),
    ).resolves.toMatchObject({
      baseStats: { attack: null, damage: null, healing: { mode: 'FIXED', amount: 4 } },
    })
  })

  it('ready y selectedAt se conservan', async () => {
    const hero = await fetchHero(
      equippedHeroContractBody({ ready: false, selectedAt: '2026-01-02T03:04:05.000Z' }),
    )

    expect(hero).toMatchObject({ ready: false, selectedAt: '2026-01-02T03:04:05.000Z' })
  })
})

describe('PlayerInventoryHttpClient — activeEffects validos (HU-25)', () => {
  it('activeEffects vacio es valido y se conserva vacio', async () => {
    await expect(fetchHero(bodyWithEffects([]))).resolves.toMatchObject({ activeEffects: [] })
  })

  it('un efecto llega completo', async () => {
    const hero = await fetchHero(bodyWithEffects([criticalChancePercentageEffect]))

    expect(hero?.activeEffects).toEqual([criticalChancePercentageEffect])
  })

  it('varios efectos conservan su orden', async () => {
    const efectos = [
      opponentDamageDiceEffect,
      attackBonusEffect,
      conditionalDefenseEffect,
      criticalChancePercentageEffect,
    ]
    const hero = await fetchHero(bodyWithEffects(efectos))

    expect(hero?.activeEffects.map((efecto) => efecto.sourceProductReference)).toEqual([
      'daga-envenenada',
      'espada-de-dos-manos',
      'amuleto-de-hierro',
      'espada-de-dos-manos',
    ])
  })

  it.each([
    ['FIXED', { mode: 'FIXED', amount: 3 }],
    ['PERCENTAGE', { mode: 'PERCENTAGE', basisPoints: 300 }],
    ['DICE', { mode: 'DICE', count: 2, sides: 8 }],
  ])('la magnitud %s se conserva sin convertir ni interpretar', async (_mode, magnitude) => {
    const hero = await fetchHero(bodyWithEffects([effectWith({ magnitude })]))

    expect(hero?.activeEffects[0]?.magnitude).toEqual(magnitude)
  })

  it.each([true, false])('hasActivationCondition=%s se conserva', async (flag) => {
    const hero = await fetchHero(bodyWithEffects([effectWith({ hasActivationCondition: flag })]))

    expect(hero?.activeEffects[0]?.hasActivationCondition).toBe(flag)
  })

  it.each([true, false])('appliedToStats=%s se conserva', async (flag) => {
    const hero = await fetchHero(bodyWithEffects([effectWith({ appliedToStats: flag })]))

    expect(hero?.activeEffects[0]?.appliedToStats).toBe(flag)
  })

  it('durationTurns se conserva cuando existe y esta ausente cuando no', async () => {
    const temporal = await fetchHero(bodyWithEffects([effectWith({ durationTurns: 3 })]))
    const permanente = await fetchHero(bodyWithEffects([criticalChancePercentageEffect]))

    expect(temporal?.activeEffects[0]?.durationTurns).toBe(3)
    expect(permanente?.activeEffects[0]).not.toHaveProperty('durationTurns')
  })

  it('un efecto sin statistic, operation ni magnitude (p. ej. una inmunidad) es valido y no los inventa', async () => {
    const inmunidad = {
      sourceProductId: 'p-1',
      sourceProductReference: 'amuleto',
      kind: 'IMMUNITY',
      target: 'SELF',
      hasActivationCondition: false,
      appliedToStats: false,
    }
    const efecto = (await fetchHero(bodyWithEffects([inmunidad])))?.activeEffects[0]

    expect(efecto).toStrictEqual(inmunidad)
    expect(efecto).not.toHaveProperty('statistic')
    expect(efecto).not.toHaveProperty('operation')
    expect(efecto).not.toHaveProperty('magnitude')
  })

  it('un kind, target o statistic que Combat no conoce NO se rechaza: se clasifica despues, no aqui', async () => {
    const nuevo = effectWith({ kind: 'FUTURE_KIND', target: 'FUTURE_TARGET', statistic: 'LUCK' })

    await expect(fetchHero(bodyWithEffects([nuevo]))).resolves.toMatchObject({
      activeEffects: [{ kind: 'FUTURE_KIND', target: 'FUTURE_TARGET', statistic: 'LUCK' }],
    })
  })
})

describe('PlayerInventoryHttpClient — lista blanca (contrato aditivo)', () => {
  it('campos extra del cuerpo NO llegan al puerto (raw, sourceSlot, name, level...)', async () => {
    const hero = await fetchHero(
      equippedHeroContractBody({
        level: 7,
        imageUrl: 'https://x/y.png',
        activeEffects: [
          { ...criticalChancePercentageEffect, raw: { stackable: false }, sourceSlot: 'WEAPON_1' },
        ],
      }),
    )

    expect(hero).not.toHaveProperty('name')
    expect(hero).not.toHaveProperty('level')
    expect(hero).not.toHaveProperty('imageUrl')
    expect(hero?.activeEffects[0]).not.toHaveProperty('raw')
    expect(hero?.activeEffects[0]).not.toHaveProperty('sourceSlot')
    expect(JSON.stringify(hero)).not.toContain('stackable')
  })

  it('el resultado tiene exactamente las claves del puerto', async () => {
    const hero = await fetchHero(equippedHeroContractBody())

    expect(Object.keys(hero ?? {}).sort()).toEqual(
      [
        'playerId',
        'heroId',
        'reference',
        'subtype',
        'baseStats',
        'effectiveStats',
        'maxPower',
        'activeEffects',
        'ready',
        'blockers',
        'loadoutVersion',
        'selectedAt',
      ].sort(),
    )
  })
})

describe('PlayerInventoryHttpClient — blockers y loadoutVersion (HU-16.1/HU-16.2, DP-1/DP-6/DP-7)', () => {
  it('ready=true con blockers vacio y loadoutVersion=0 se conservan tal cual', async () => {
    const hero = await fetchHero(equippedHeroContractBody())

    expect(hero).toMatchObject({ ready: true, blockers: [], loadoutVersion: 0 })
  })

  it('ready=false con blockers reales: se reenvian TAL CUAL, sin envolver ni traducir', async () => {
    const hero = await fetchHero(
      equippedHeroContractBody({
        ready: false,
        blockers: [
          {
            code: 'EQUIPPED_PRODUCT_NOT_OWNED',
            slot: 'WEAPON_1',
            reference: 'espada-de-dos-manos',
            detail: 'El producto equipado ya no esta en el inventario del jugador.',
          },
        ],
      }),
    )

    expect(hero?.blockers).toEqual([
      {
        code: 'EQUIPPED_PRODUCT_NOT_OWNED',
        slot: 'WEAPON_1',
        reference: 'espada-de-dos-manos',
        detail: 'El producto equipado ya no esta en el inventario del jugador.',
      },
    ])
  })

  it('un blocker con slot=null (impedimento del propio heroe, no de una ranura) es valido', async () => {
    const hero = await fetchHero(
      equippedHeroContractBody({
        ready: false,
        blockers: [
          {
            code: 'HERO_NOT_ACTIVE',
            slot: null,
            reference: 'guerrero-armas',
            detail: 'Suspendido.',
          },
        ],
      }),
    )

    expect(hero?.blockers[0]?.slot).toBeNull()
  })

  it('un codigo de blocker que Combat no conoce NO se rechaza: el vocabulario lo posee Player-Inventory', async () => {
    const hero = await fetchHero(
      equippedHeroContractBody({
        ready: false,
        blockers: [
          { code: 'FUTURE_BLOCKER_CODE', slot: null, reference: 'guerrero-armas', detail: 'x' },
        ],
      }),
    )

    expect(hero?.blockers[0]?.code).toBe('FUTURE_BLOCKER_CODE')
  })

  it('loadoutVersion mayor que 0 se conserva', async () => {
    const hero = await fetchHero(equippedHeroContractBody({ loadoutVersion: 5 }))

    expect(hero?.loadoutVersion).toBe(5)
  })

  it.each([
    ['loadoutVersion ausente', { loadoutVersion: undefined }],
    ['loadoutVersion negativo', { loadoutVersion: -1 }],
    ['loadoutVersion decimal', { loadoutVersion: 1.5 }],
    ['loadoutVersion como texto', { loadoutVersion: '1' }],
    [
      'blockers ausente (Player-Inventory anterior al contrato): NO se sustituye por []',
      { blockers: undefined },
    ],
    ['blockers nulo', { blockers: null }],
    ['blockers como objeto en vez de lista', { blockers: { 0: 'x' } }],
    ['un elemento de blockers que no es un objeto', { blockers: ['motivo'] }],
    ['un blocker sin code', { blockers: [{ slot: null, reference: 'r', detail: 'd' }] }],
    [
      'un blocker con code vacio',
      { blockers: [{ code: '', slot: null, reference: 'r', detail: 'd' }] },
    ],
    ['un blocker sin reference', { blockers: [{ code: 'C', slot: null, detail: 'd' }] }],
    ['un blocker sin detail', { blockers: [{ code: 'C', slot: null, reference: 'r' }] }],
    [
      'un blocker con slot numerico (no string ni null)',
      { blockers: [{ code: 'C', slot: 1, reference: 'r', detail: 'd' }] },
    ],
    [
      'un blocker con slot vacio (distinto de null, se exige no vacio)',
      { blockers: [{ code: 'C', slot: '', reference: 'r', detail: 'd' }] },
    ],
  ])('%s -> respuesta invalida (503)', async (_case, change) => {
    await expectRejected(equippedHeroContractBody(change))
  })
})

describe('PlayerInventoryHttpClient — respuestas invalidas (503, nunca un valor inventado)', () => {
  it.each([
    ['cuerpo que no es un objeto', 'texto'],
    ['cuerpo nulo', null],
    ['cuerpo que es un arreglo', []],
  ])('%s', async (_case, body) => {
    await expectRejected(body)
  })

  it('playerId de la respuesta distinto del pedido', async () => {
    await expectRejected(equippedHeroContractBody({ playerId: 'otro-jugador' }))
  })

  it.each([
    ['heroId vacio', { heroId: '' }],
    ['heroId en blanco', { heroId: '   ' }],
    ['heroId ausente', { heroId: undefined }],
    ['heroId numerico', { heroId: 7 }],
    ['reference ausente', { reference: undefined }],
    ['reference vacia', { reference: '' }],
    ['subtype ausente', { subtype: undefined }],
    ['subtype vacio', { subtype: '' }],
    ['subtype numerico', { subtype: 3 }],
    ['ready ausente', { ready: undefined }],
    ['ready como texto', { ready: 'true' }],
    ['selectedAt ausente', { selectedAt: undefined }],
    ['selectedAt que no es una fecha', { selectedAt: 'ayer' }],
    ['selectedAt numerico', { selectedAt: 1758283200000 }],
  ])('%s', async (_case, change) => {
    await expectRejected(equippedHeroContractBody(change))
  })

  describe('estadisticas malformadas', () => {
    it.each([
      ['baseStats ausente', undefined],
      ['baseStats nulo', null],
      ['baseStats que no es un objeto', 'texto'],
      ['power negativo', statsWith({ power: -1 })],
      ['power decimal', statsWith({ power: 1.5 })],
      ['health como texto', statsWith({ health: '40' })],
      ['health ausente', statsWith({ health: undefined })],
      ['defense negativa', statsWith({ defense: -2 })],
      ['attack ausente (no se interpreta como null)', statsWith({ attack: undefined })],
      ['attack como texto', statsWith({ attack: '10' })],
      ['attack decimal', statsWith({ attack: 10.5 })],
      ['damage con modo desconocido', statsWith({ damage: { mode: 'RANDOM', amount: 1 } })],
      ['damage DICE sin sides', statsWith({ damage: { mode: 'DICE', count: 1 } })],
      ['damage ausente (no se interpreta como null)', statsWith({ damage: undefined })],
      ['healing que no es una magnitud', statsWith({ healing: 'mucho' })],
    ])('baseStats: %s', async (_case, baseStats) => {
      await expectRejected(equippedHeroContractBody({ baseStats }))
    })

    it.each([
      ['effectiveStats ausente', undefined],
      ['effectiveStats nulo', null],
      ['power decimal', statsWith({ power: 7.5 })],
      ['power como texto', statsWith({ power: '10' })],
    ])('effectiveStats: %s', async (_case, effectiveStats) => {
      await expectRejected(equippedHeroContractBody({ effectiveStats }))
    })
  })

  describe('activeEffects malformado', () => {
    it.each([
      ['ausente (Player-Inventory anterior al contrato): NO se sustituye por []', undefined],
      ['nulo', null],
      ['un objeto en vez de una lista', { 0: criticalChancePercentageEffect }],
      ['texto', 'ninguno'],
    ])('activeEffects %s', async (_case, activeEffects) => {
      await expectRejected(equippedHeroContractBody({ activeEffects }))
    })

    it.each([
      ['un elemento que no es un objeto', 'efecto'],
      ['un elemento nulo', null],
      ['un elemento que es una lista', []],
      ['sin sourceProductId', effectWith({ sourceProductId: undefined })],
      ['sourceProductId vacio', effectWith({ sourceProductId: '' })],
      ['sin sourceProductReference', effectWith({ sourceProductReference: undefined })],
      ['sin kind', effectWith({ kind: undefined })],
      ['kind vacio', effectWith({ kind: '' })],
      ['sin target', effectWith({ target: undefined })],
      [
        'statistic nulo (los opcionales se omiten, no vienen a null)',
        effectWith({ statistic: null }),
      ],
      ['statistic numerico', effectWith({ statistic: 5 })],
      ['operation numerica', effectWith({ operation: 1 })],
      ['magnitude nula', effectWith({ magnitude: null })],
      ['magnitude con modo desconocido', effectWith({ magnitude: { mode: 'RANDOM' } })],
      [
        'magnitude PERCENTAGE con basisPoints como texto',
        effectWith({ magnitude: { mode: 'PERCENTAGE', basisPoints: '300' } }),
      ],
      [
        'magnitude PERCENTAGE con basisPoints decimal',
        effectWith({ magnitude: { mode: 'PERCENTAGE', basisPoints: 300.5 } }),
      ],
      ['magnitude FIXED negativa', effectWith({ magnitude: { mode: 'FIXED', amount: -1 } })],
      ['magnitude DICE sin count', effectWith({ magnitude: { mode: 'DICE', sides: 6 } })],
      ['durationTurns cero', effectWith({ durationTurns: 0 })],
      ['durationTurns negativo', effectWith({ durationTurns: -1 })],
      ['durationTurns decimal', effectWith({ durationTurns: 1.5 })],
      ['durationTurns como texto', effectWith({ durationTurns: '3' })],
      ['sin hasActivationCondition', effectWith({ hasActivationCondition: undefined })],
      ['hasActivationCondition como texto', effectWith({ hasActivationCondition: 'false' })],
      ['sin appliedToStats', effectWith({ appliedToStats: undefined })],
      ['appliedToStats numerico', effectWith({ appliedToStats: 0 })],
    ])('%s', async (_case, efecto) => {
      await expectRejected(bodyWithEffects([efecto]))
    })

    it('UN efecto malformado invalida TODA la respuesta: no se descarta en silencio y se sigue', async () => {
      await expectRejected(
        bodyWithEffects([
          attackBonusEffect,
          effectWith({ kind: undefined }),
          conditionalDefenseEffect,
        ]),
      )
    })
  })
})

describe('PlayerInventoryHttpClient — 404 y errores de transporte (comportamiento existente)', () => {
  it('404 sigue siendo null: es el camino de negocio "sin heroe equipado", no un error', async () => {
    await expect(clientReturning(404, {}).getEquippedHero('sin-heroe')).resolves.toBeNull()
  })

  it.each([401, 403, 500, 502, 503])(
    '%s -> UpstreamServiceError, sin un heroe inventado',
    async (status) => {
      await expect(
        clientReturning(status, equippedHeroContractBody()).getEquippedHero('jugador-1'),
      ).rejects.toBeInstanceOf(UpstreamServiceError)
    },
  )

  it('fetch rechaza (no alcanzable) -> UpstreamServiceError, no el error crudo de red', async () => {
    const client = new PlayerInventoryHttpClient({
      baseUrl: 'https://player-inventory.internal',
      callerService: 'combat',
      secret: 'secreto-compartido-de-pruebas',
      clock,
      logger: silentLogger,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    })

    await expect(client.getEquippedHero('jugador-1')).rejects.toBeInstanceOf(UpstreamServiceError)
  })
})
