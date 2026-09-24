import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guarda estatica de HU-17 (RF-17): la cola de turnos se genera SOLO con la
 * fuente centralizada de HU-24, sin otra fuente de aleatoriedad, sin reloj y
 * sin conocer el interior del motor (semilla, MT19937, Box-Muller, CDF).
 * Se comprueba sobre el CODIGO FUENTE sin comentarios.
 */
const ROOT = join(__dirname, '..', '..', 'src')

const HU_17_SOURCES = [
  'domain/entities/BattleEvent.ts',
  'domain/entities/BattleRoom.ts',
  'domain/entities/BattleState.ts',
  'domain/entities/TurnOrder.ts',
  'domain/errors/BattleErrors.ts',
  'domain/policies/TurnOrderPolicy.ts',
  'application/services/BoundedRandom.ts',
  'application/use-cases/StartBattle.ts',
  'application/use-cases/CompleteBattleTurn.ts',
  'application/use-cases/GetBattleRoom.ts',
  'application/use-cases/ResumeBattle.ts',
  'application/use-cases/RealtimeTickets.ts',
].map((file) => join(ROOT, ...file.split('/')))

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['Math.random', /Math\s*\.\s*random/],
  [
    'node:crypto / randomInt / randomBytes / getRandomValues / randomUUID',
    /node:crypto|from 'crypto'|randomInt|randomBytes|getRandomValues|randomUUID/,
  ],
  ['reloj como fuente (Date.now / new Date() sin argumentos)', /Date\s*\.\s*now|new Date\(\s*\)/],
  ['MT19937 (HU-24)', /Mt19937/],
  ['Box-Muller (HU-24)', /BoxMuller/],
  ['CDF normal (HU-24)', /StandardNormalCdf|standardNormalCdf|CdfUniform/],
  ['la variable normal cruda', /nextNormal|NormalSequencePort|createNormalSequence/],
  ['la semilla (HU-24)', /RandomSeed/],
  ['la fabrica de secuencias', /RandomSequenceFactory|RANDOM_SEQUENCE_FACTORY/],
  ['adaptadores o infraestructura', /adapters\/|infrastructure\//],
  ['NestJS', /@nestjs\//],
]

const allTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)

    return statSync(path).isDirectory()
      ? allTypeScriptFiles(path)
      : path.endsWith('.ts')
        ? [path]
        : []
  })

describe('HU-17 no usa otra fuente de aleatoriedad ni conoce el motor (RF-17)', () => {
  it.each(FORBIDDEN)('ningun archivo de HU-17 referencia %s', (_label, pattern) => {
    for (const file of HU_17_SOURCES) {
      const code = withoutComments(readFileSync(file, 'utf8'))

      expect({ file, matches: pattern.test(code) }).toEqual({ file, matches: false })
    }
  })

  it('la unica via de sorteo es RandomSequencePort.nextIndex(), con muestreo por rechazo', () => {
    const code = withoutComments(
      readFileSync(join(ROOT, 'application', 'services', 'BoundedRandom.ts'), 'utf8'),
    )

    expect(code).toMatch(/sequence\.nextIndex\(\)/)
    expect(code).toMatch(/RandomSequencePort/)
    expect(code).toMatch(/limit/)
  })

  it('la politica de la cola solo conoce BoundedRandom (abstraccion de dominio), no el motor', () => {
    const code = withoutComments(
      readFileSync(join(ROOT, 'domain', 'policies', 'TurnOrderPolicy.ts'), 'utf8'),
    )

    expect(code).toMatch(/BoundedRandom/)
    expect(code).toMatch(/random\.nextInt/)
    expect(code).not.toMatch(/nextIndex|RandomIndex/)
  })

  it('el ticket del WebSocket es el UNICO uso de node:crypto de HU-17 y no decide nada del juego', () => {
    const users = allTypeScriptFiles(ROOT)
      .filter((file) =>
        /node:crypto|from 'crypto'/.test(withoutComments(readFileSync(file, 'utf8'))),
      )
      .map((file) => file.slice(ROOT.length + 1).replaceAll('\\', '/'))
      .sort()

    // Ademas de la firma HMAC (contrato interno) y el UUID de las salas (existentes antes de HU-17).
    // `inventory-grant-operation-id.ts` (HU-22): SHA-1 DETERMINISTA de un id logico para
    // derivar un UUID v5 (idempotencia hacia Player-Inventory). Es un hash, no una fuente
    // de azar: no sortea ni decide nada del juego.
    expect(users).toEqual([
      'adapters/outbound/http/inventory-grant-operation-id.ts',
      'adapters/outbound/identity/internal-signature.ts',
      'adapters/outbound/system/CryptoRealtimeTicketCodec.ts',
      'adapters/outbound/system/UuidGenerator.ts',
    ])
  })

  it('el codigo del gateway no envia semilla, estado del generador ni sorteos al cliente', () => {
    const code = withoutComments(
      readFileSync(join(ROOT, 'adapters', 'inbound', 'ws', 'BattleRoomRealtimeGateway.ts'), 'utf8'),
    )

    expect(code).not.toMatch(/seed|semilla|Mt19937|randomSeed/i)
  })

  it('el DTO de la sala y el de eventos no exponen semilla ni estado del generador', () => {
    for (const file of ['dto/BattleRoomDto.ts', 'dto/BattleEventDto.ts']) {
      const code = withoutComments(
        readFileSync(join(ROOT, 'application', ...file.split('/')), 'utf8'),
      )

      expect(code).not.toMatch(/seed|semilla|Mt19937|randomSeed|draws/i)
    }
  })
})
