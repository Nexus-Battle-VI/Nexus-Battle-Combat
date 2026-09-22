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
import { stakeReserveOperationIdOf } from '../services/StakeOperationIds'
import type { StakeReserver } from '../services/StakeReserver'

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
 * HU-23 (D8): si algun participante declara apuesta, el `holdOperationId` se
 * resuelve AQUI (determinista, con el `roomId` ya generado) y la reserva
 * contra Wallet es SINCRONA, antes de persistir: si Wallet rechaza, el
 * `execute()` completo lanza y no queda ninguna sala. La sala se guarda con
 * las apuestas ya `ACTIVE`.
 *
 * LAS DEMAS REGLAS DE NEGOCIO VIVEN EN `BattleRoom.create()`: este caso de
 * uso solo orquesta generar el id, resolver la identidad del creador para
 * los participantes declarados, invocar al dominio, reservar y persistir.
 */
export class CreateBattleRoom {
  constructor(
    private readonly rooms: BattleRoomRepositoryPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly stakeReserver: StakeReserver,
  ) {}

  async execute(createdBy: string, input: CreateBattleRoomInput): Promise<BattleRoomDto> {
    const roomId = this.ids.generate()
    const resolved: CreateBattleRoomInput = {
      ...input,
      teamConfigs: input.teamConfigs.map((config) => resolveTeamConfig(config, createdBy, roomId)),
    }

    const room = BattleRoom.create(roomId, createdBy, resolved, this.clock.now())
    const withStakes = await this.stakeReserver.reservePending(room)
    const saved = await this.rooms.save(withStakes, 0)

    return toBattleRoomDto(saved, createdBy)
  }
}

const resolveTeamConfig = (
  config: TeamConfigInput,
  createdBy: string,
  roomId: string,
): TeamConfigInput => ({
  ...config,
  initialParticipants: config.initialParticipants?.map((participant) =>
    resolveParticipant(participant, createdBy, roomId),
  ),
})

const resolveParticipant = (
  participant: ParticipantInput,
  createdBy: string,
  roomId: string,
): ParticipantInput => {
  if (participant.kind !== ParticipantKind.Human) {
    return participant
  }

  return {
    ...participant,
    playerId: createdBy,
    ...(participant.stake === undefined
      ? {}
      : {
          stake: {
            amount: participant.stake.amount,
            holdOperationId: stakeReserveOperationIdOf(roomId, createdBy),
          },
        }),
  }
}
