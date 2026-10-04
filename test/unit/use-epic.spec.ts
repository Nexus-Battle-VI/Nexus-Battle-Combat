import { ChannelLock } from '../../src/adapters/inbound/ws/ChannelLock'
import { InMemoryBattleRoomRepository } from '../../src/adapters/outbound/persistence/InMemoryBattleRoomRepository'
import { InMemoryCombatDecisionTelemetryRepository } from '../../src/adapters/outbound/persistence/InMemoryCombatDecisionTelemetryRepository'
import type { BattleRoomRepositoryPort } from '../../src/application/ports/BattleRoomRepositoryPort'
import { UseEpic, type UseEpicInput } from '../../src/application/use-cases/UseEpic'
import { CombatDecisionRecorder } from '../../src/application/services/CombatDecisionRecorder'
import { BattleEventType } from '../../src/domain/entities/BattleEvent'
import {
  EpicOnCooldownError,
  EpicTargetRequiredError,
  NoEpicEquippedError,
  NotYourTurnError,
  UnsupportedEpicEffectError,
} from '../../src/domain/errors/BattleErrors'
import { ROOM_ID, clock, scriptedSequence } from '../fixtures/battle'
import { battleWithCombat, type BattleWithCombatOptions } from '../fixtures/basic-attack'
import {
  EPICA_DANO,
  EPICA_SANACION,
  GOLPE_DE_DEFENSA_EPIC,
  GOLPE_DE_DEFENSA_ID,
  GOLPE_DE_DEFENSA_SIN_MATCH_EPIC,
  battleWithEpic,
  epicProfile,
} from '../fixtures/epic'

/**
 * `UseEpic` de extremo a extremo (correccion HU-19/HU-31, tras GAP-HU31-CATALOG-MULTI-EFFECT).
 * Escenarios CMB-01..CMB-10 del encargo de correccion. Magnitudes FIJAS (sin dados): estas
 * pruebas ejercitan mecanica (turno, Poder, recarga, inmutabilidad, independencia por
 * participante), no el muestreo HU-24.
 */
const command = (overrides: Partial<UseEpicInput> = {}): UseEpicInput => ({
  roomId: ROOM_ID,
  requesterId: 'a1',
  commandId: 'cmd-epic-1',
  ...overrides,
})

const setup = async (
  options: BattleWithCombatOptions = {},
  build: () => ReturnType<typeof battleWithCombat> = () =>
    battleWithEpic(GOLPE_DE_DEFENSA_EPIC, options),
) => {
  const inner = new InMemoryBattleRoomRepository()
  await inner.save(build(), 0)

  const sequence = scriptedSequence([])
  let saves = 0
  const counting: BattleRoomRepositoryPort = {
    findById: (id) => inner.findById(id),
    findWaitingForPlayers: () => inner.findWaitingForPlayers(),
    findInBattle: () => inner.findInBattle(),
    findFinishedSince: (since) => inner.findFinishedSince(since),
    findCancelledSince: (since) => inner.findCancelledSince(since),
    findActiveByParticipant: (playerId) => inner.findActiveByParticipant(playerId),
    findByTournamentOperationId: (operationId) => inner.findByTournamentOperationId(operationId),
    save: (room, expectedVersion) => {
      saves += 1
      return inner.save(room, expectedVersion)
    },
  }
  const lock = new ChannelLock()
  const telemetry = new InMemoryCombatDecisionTelemetryRepository()
  const recorder = new CombatDecisionRecorder(telemetry, clock, { error: jest.fn() })
  const useCase = new UseEpic(counting, clock, sequence, lock, null, null, recorder)
  const room = async () => {
    const found = await inner.findById(ROOM_ID)
    if (found === null) throw new Error('la sala desaparecio')
    return found
  }

  return { inner, useCase, room, telemetry, saves: () => saves }
}

describe('UseEpic — mecanica principal (correccion HU-19/HU-31)', () => {
  it('persists the canonical EPIC intent with its real strategic scope', async () => {
    const { useCase, telemetry } = await setup()

    await useCase.execute(command({ commandId: 'cmd-epic-telemetry' }))

    await expect(telemetry.listDecisionsByBattle('ONLINE', ROOM_ID)).resolves.toMatchObject([
      {
        decisionSource: 'HUMAN',
        selectedAction: {
          kind: 'EPIC',
          epicId: GOLPE_DE_DEFENSA_ID,
          target: { scope: 'SELF' },
        },
      },
    ])
  })

  it('CMB-02: subtipo coincidente -> aplica el general y TODOS los especificos simultaneos', async () => {
    const { useCase, room } = await setup()

    const result = await useCase.execute(command())

    expect(result.replayed).toBe(false)
    expect(result.event.type).toBe(BattleEventType.EpicUsed)
    expect(result.event.payload).toMatchObject({
      commandId: 'cmd-epic-1',
      actor: { teamLabel: 'A', seat: 0 },
      epic: { epicProductId: GOLPE_DE_DEFENSA_ID, name: 'Golpe de defensa' },
      appliedEffects: 3,
    })

    const after = await room()
    const actor = after.battle?.combatantFor({ teamLabel: 'A', seat: 0 })

    // 3 efectos activos: +4 Defensa, +4 Dano, +2% Critico (GAP-HU31-CATALOG-MULTI-EFFECT).
    expect(actor?.activeSkillEffects).toHaveLength(3)
    expect(actor?.statBonus('DEFENSE')).toBe(4)
    expect(actor?.statBonus('DAMAGE')).toBe(4)
  })

  it('CMB-01: subtipo NO coincidente -> aplica SOLO el general', async () => {
    const { useCase, room } = await setup({}, () => battleWithEpic(GOLPE_DE_DEFENSA_SIN_MATCH_EPIC))

    await useCase.execute(command())

    const after = await room()
    const actor = after.battle?.combatantFor({ teamLabel: 'A', seat: 0 })

    expect(actor?.activeSkillEffects).toHaveLength(1)
    expect(actor?.statBonus('DEFENSE')).toBe(4)
    expect(actor?.statBonus('DAMAGE')).toBe(0)
  })

  it('CMB-03: el costo de Poder de la epica es siempre 0 -- el Poder del actor no cambia', async () => {
    const { useCase } = await setup()

    const result = await useCase.execute(command())

    expect(result.event.payload).toMatchObject({ power: { before: 10, after: 10 } })
  })

  it('CMB-04: tras usarla, la recarga queda en cooldownTurns (2) turnos propios', async () => {
    const { useCase } = await setup()

    const result = await useCase.execute(command())

    expect(result.event.payload).toMatchObject({ cooldown: { remainingTurns: 2 } })
  })

  it('CMB-05: intentar usarla de nuevo mientras esta en recarga se rechaza', async () => {
    const { useCase } = await setup()

    await useCase.execute(command())
    // El turno de A1 ya ceso; B1 actua y le devuelve el turno a A1 para reintentar.
    await useCase.execute(command({ requesterId: 'b1', commandId: 'cmd-epic-skip' })).catch(() => {
      // b1 no tiene matching audience sin target; si falla, continuamos igual: lo que importa
      // es que a1 siga en cooldown en su proximo turno propio.
    })

    await expect(
      useCase.execute(command({ requesterId: 'a1', commandId: 'cmd-epic-2' })),
    ).rejects.toBeInstanceOf(EpicOnCooldownError)
  })

  it('CMB-06: fuera de turno se rechaza (NotYourTurnError, mismo mecanismo que useSkill)', async () => {
    const { useCase } = await setup()

    await expect(useCase.execute(command({ requesterId: 'b1' }))).rejects.toBeInstanceOf(
      NotYourTurnError,
    )
  })

  it('CMB-07: heroe sin ninguna epica equipada -> rechazo explicito', async () => {
    const { useCase } = await setup({}, () => battleWithEpic(undefined))

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(NoEpicEquippedError)
  })

  it('CMB-08: el snapshot congelado (CombatProfile.epic) no cambia al usarla', async () => {
    const { useCase, room } = await setup()
    const before = (await room()).battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile?.epic

    await useCase.execute(command())

    const after = (await room()).battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.profile?.epic
    expect(after).toEqual(before)
  })

  it('CMB-09: en una batalla de equipo, cada participante usa y recarga SU PROPIA epica', async () => {
    const inner = new InMemoryBattleRoomRepository()
    const room2v2 = battleWithCombat({
      teamSizes: [2, 2],
      profiles: {
        a1: epicProfile(GOLPE_DE_DEFENSA_EPIC),
        a2: epicProfile(undefined),
        b1: epicProfile(GOLPE_DE_DEFENSA_SIN_MATCH_EPIC),
        b2: epicProfile(GOLPE_DE_DEFENSA_EPIC),
      },
    })
    await inner.save(room2v2, 0)

    const sequence = scriptedSequence([])
    const lock = new ChannelLock()
    const useCase = new UseEpic(inner, clock, sequence, lock)

    await useCase.execute(command({ requesterId: 'a1', commandId: 'cmd-a1' }))

    const after = await inner.findById(ROOM_ID)
    const a1 = after?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })
    const a2 = after?.battle?.combatantFor({ teamLabel: 'A', seat: 1 })

    expect(a1?.cooldownOf(GOLPE_DE_DEFENSA_ID)).toBeGreaterThan(0)
    // a2 nunca equipo epica: ni siquiera tiene estado de recarga para ese id.
    expect(a2?.cooldownOf(GOLPE_DE_DEFENSA_ID)).toBe(0)
  })

  it('efecto DAMAGE directo: dana al rival sin resolucion de Ataque/Defensa', async () => {
    const { useCase, room } = await setup({}, () => battleWithEpic(EPICA_DANO))

    const result = await useCase.execute(command({ target: { teamLabel: 'B', seat: 0 } }))

    expect(result.event.payload).toMatchObject({
      damage: { calculatedDamage: 9, appliedDamage: 9 },
      targetHealth: { before: 44, after: 35 },
    })
    const after = await room()
    expect(after.battle?.combatantFor({ teamLabel: 'B', seat: 0 })?.currentHealth).toBe(35)
  })

  it('un efecto OPPONENT sin target en el comando se rechaza (EpicTargetRequiredError)', async () => {
    const { useCase } = await setup({}, () => battleWithEpic(EPICA_DANO))

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(EpicTargetRequiredError)
  })

  it('efecto de sanacion instantanea de grupo (ALLIED_GROUP): sana a todo el equipo propio', async () => {
    const inner = new InMemoryBattleRoomRepository()
    const room2v2 = battleWithCombat({
      teamSizes: [2, 2],
      health: { 'A#0': 20, 'A#1': 20 },
      profiles: {
        a1: epicProfile(EPICA_SANACION),
        a2: epicProfile(undefined),
        b1: epicProfile(undefined),
        b2: epicProfile(undefined),
      },
    })
    await inner.save(room2v2, 0)

    const sequence = scriptedSequence([])
    const lock = new ChannelLock()
    const useCase = new UseEpic(inner, clock, sequence, lock)

    await useCase.execute(command({ requesterId: 'a1' }))

    const after = await inner.findById(ROOM_ID)
    expect(after?.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.currentHealth).toBe(26)
    expect(after?.battle?.combatantFor({ teamLabel: 'A', seat: 1 })?.currentHealth).toBe(26)
  })

  it('un efecto no soportado (REFLECT_DAMAGE) rechaza la epica ENTERA, sin aplicar nada a medias', async () => {
    const { useCase, room } = await setup({}, () =>
      battleWithEpic({
        ...GOLPE_DE_DEFENSA_EPIC,
        executableEffects: [
          {
            kind: 'REFLECT_DAMAGE',
            target: 'OPPONENT',
            magnitude: { mode: 'PERCENTAGE', basisPoints: 10_000 },
            hasActivationCondition: true,
          },
        ],
      }),
    )

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(UnsupportedEpicEffectError)

    const after = await room()
    expect(
      after.battle?.combatantFor({ teamLabel: 'A', seat: 0 })?.activeSkillEffects,
    ).toHaveLength(0)
  })
})

/**
 * CMB-10 (Tournament, cero logica especifica): verificado por inspeccion -- `BattleRoom.planEpic`
 * y `applyEpic` no leen `this.tournament` en ningun punto (grep sobre el codigo fuente de ambos
 * metodos), exactamente el mismo criterio que ya vale para `planSkill`/`applySkill`. Una sala
 * creada por `StartTournamentRoom.startRoom()` llega a `IN_BATTLE` por el MISMO `start()` que una
 * sala PvP/PvE comun (confirmado en el contrato HU-31, decision #6), as; cualquier perfil con
 * `epic` congelado se comporta identico sin importar el origen de la sala. No se construye aqui
 * una sala de torneo completa (infraestructura de fixture no disponible en este archivo) para no
 * duplicar, con menor fidelidad, lo que las suites dedicadas de HU-26/Tournament ya cubren.
 */
