import {
  BattleRoom,
  type CreateBattleRoomInput,
  type TeamConfigInput,
} from '../../domain/entities/BattleRoom'
import { ParticipantKind, type ParticipantInput } from '../../domain/entities/Participant'
import { toBattleRoomDto, type BattleRoomDto } from '../dto/BattleRoomDto'
import type { BattleRoomRepositoryPort } from '../ports/BattleRoomRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'

/**
 * Crea una sala de batalla (HU-14, RF-14, CA-01).
 *
 * EL IDENTIFICADOR LO GENERA EL SERVIDOR. `createdBy` llega YA resuelto por
 * el controlador desde `identity.subject` del JWT verificado — este caso de
 * uso nunca lee un `playerId`/`createdBy` de la peticion (HU-14.1,
 * `HU-14.1-Contrato-Creacion-Sala.md`, seccion "Autenticacion").
 *
 * EL `playerId` DE UN PARTICIPANTE `HUMAN` DECLARADO SE RESUELVE AQUI, NUNCA
 * DEL CLIENTE: el DTO HTTP (`ParticipantRequest`) no tiene ese campo, asi que
 * el unico humano que un cliente puede declarar al crear es el propio
 * creador (HU-14.1, `HU-14.1-Decisiones-Tecnicas.md`, punto 3). El dominio
 * (`BattleRoom.create()`) exige `playerId` en todo participante `HUMAN` y NO
 * lo infiere: si esta resolucion se omitiera aqui, declarar un `HUMAN`
 * inicial seria imposible desde la API.
 *
 * LAS DEMAS REGLAS DE NEGOCIO VIVEN EN `BattleRoom.create()`: este caso de
 * uso solo orquesta generar el id, resolver la identidad del creador para
 * los participantes declarados, invocar al dominio y persistir.
 */
export class CreateBattleRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(createdBy: string, input: CreateBattleRoomInput): Promise<BattleRoomDto> {
    const resolved: CreateBattleRoomInput = {
      ...input,
      teamConfigs: input.teamConfigs.map((config) => resolveTeamConfig(config, createdBy)),
    }

    const room = BattleRoom.create(this.ids.generate(), createdBy, resolved, this.clock.now())
    const saved = await this.rooms.save(room, 0)

    return toBattleRoomDto(saved)
  }
}

const resolveTeamConfig = (config: TeamConfigInput, createdBy: string): TeamConfigInput => ({
  ...config,
  initialParticipants: config.initialParticipants?.map((participant) =>
    resolveParticipant(participant, createdBy),
  ),
})

const resolveParticipant = (participant: ParticipantInput, createdBy: string): ParticipantInput =>
  participant.kind === ParticipantKind.Human ? { ...participant, playerId: createdBy } : participant
