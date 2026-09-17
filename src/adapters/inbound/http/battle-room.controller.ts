import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  InvalidModeCompositionError,
  InvalidRewardError,
  InvalidRoomCapacityError,
  InvalidTeamCapacityError,
  RoomCancellationForbiddenError,
  RoomNotCancellableError,
} from '../../../domain/errors/BattleRoomErrors'
import { RoomConflictError, RoomNotFoundError } from '../../../application/errors/ApplicationError'
import type { BattleRoomDto } from '../../../application/dto/BattleRoomDto'
import type { CancelBattleRoom } from '../../../application/use-cases/CancelBattleRoom'
import type { CreateBattleRoom } from '../../../application/use-cases/CreateBattleRoom'
import type { ListAvailableBattleRooms } from '../../../application/use-cases/ListAvailableBattleRooms'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CurrentIdentity } from './auth/decorators'
import { BattleRoomResponse, CreateBattleRoomRequest } from './battle-room.dto'
import { CANCEL_BATTLE_ROOM, CREATE_BATTLE_ROOM, LIST_AVAILABLE_BATTLE_ROOMS } from './tokens'

/**
 * Creacion, listado y cancelacion de salas de batalla (HU-14, RF-14).
 *
 * LA IDENTIDAD DEL CREADOR SALE EXCLUSIVAMENTE DEL SUJETO VERIFICADO DEL
 * TESTIMONIO. Ni el cuerpo ni la URL aceptan `createdBy`/`playerId`: no
 * existe un identificador manipulable con el que crear o cancelar una sala
 * en nombre de otra persona (HU-14.1, `HU-14.1-Contrato-Creacion-Sala.md`,
 * seccion "Autenticacion"). Ninguna ruta de este controlador es `@Public()`:
 * nace protegida por el `JwtAuthGuard` global, igual que el resto del
 * servicio.
 */
@ApiTags('battle-rooms')
@ApiBearerAuth()
@Controller('v1/combat/rooms')
export class BattleRoomController {
  constructor(
    @Inject(CREATE_BATTLE_ROOM) private readonly createBattleRoom: CreateBattleRoom,
    @Inject(LIST_AVAILABLE_BATTLE_ROOMS)
    private readonly listAvailableBattleRooms: ListAvailableBattleRooms,
    @Inject(CANCEL_BATTLE_ROOM) private readonly cancelBattleRoom: CancelBattleRoom,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crea una sala de batalla en WAITING_FOR_PLAYERS' })
  @ApiResponse({ status: 201, type: BattleRoomResponse })
  @ApiResponse({ status: 400, description: 'Cuerpo invalido (formato/tipo)' })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({
    status: 422,
    description: 'Regla de negocio incumplida (capacidad, composicion, recompensa)',
  })
  async create(
    @Body() body: CreateBattleRoomRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<BattleRoomDto> {
    try {
      return await this.createBattleRoom.execute(identity.subject, body)
    } catch (error: unknown) {
      throw BattleRoomController.translate(error)
    }
  }

  @Get()
  @ApiOperation({ summary: 'Lista las salas disponibles (WAITING_FOR_PLAYERS y con cupo)' })
  @ApiResponse({ status: 200, type: BattleRoomResponse, isArray: true })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  async list(): Promise<readonly BattleRoomDto[]> {
    return this.listAvailableBattleRooms.execute()
  }

  @Post(':roomId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela una sala propia en WAITING_FOR_PLAYERS' })
  @ApiResponse({ status: 200, type: BattleRoomResponse })
  @ApiResponse({ status: 400, description: 'roomId no es un UUID v4 valido' })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({ status: 403, description: 'Quien pide no es el creador de la sala' })
  @ApiResponse({ status: 404, description: 'La sala no existe' })
  @ApiResponse({
    status: 409,
    description: 'La sala no esta en WAITING_FOR_PLAYERS, o conflicto de version',
  })
  async cancel(
    // `ParseUUIDPipe({version: '4'})`: HU-14.1 fija `BattleRoomId` como UUID
    // v4 (mismo formato que `BattleRoomId.create()` exige en el dominio). Un
    // `roomId` mal formado se rechaza aqui con 400 explicito, en vez de
    // llegar al repositorio y convertirse silenciosamente en un 404 que
    // sugeriria "sala inexistente" cuando en realidad el dato de entrada es
    // invalido.
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<BattleRoomDto> {
    try {
      return await this.cancelBattleRoom.execute(roomId, identity.subject)
    } catch (error: unknown) {
      throw BattleRoomController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof RoomNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof RoomCancellationForbiddenError) {
      return new ForbiddenException(error.message)
    }

    if (error instanceof RoomNotCancellableError || error instanceof RoomConflictError) {
      return new ConflictException(error.message)
    }

    if (
      error instanceof InvalidTeamCapacityError ||
      error instanceof InvalidRoomCapacityError ||
      error instanceof InvalidModeCompositionError ||
      error instanceof InvalidRewardError
    ) {
      return new UnprocessableEntityException(error.message)
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
