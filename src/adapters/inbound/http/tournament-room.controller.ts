import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  BattleNotInProgressError,
  NotYourTurnError,
  RoomNotStartableError,
  UnsupportedTeamCompositionError,
} from '../../../domain/errors/BattleErrors'
import { InvalidTournamentRosterError } from '../../../domain/errors/BattleRoomErrors'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../../application/errors/ApplicationError'
import { PrecombatEligibilityBlockedError } from '../../../application/errors/PrecombatEligibilityError'
import {
  NotATournamentRoomError,
  TournamentRoomMismatchError,
  TournamentRoomOperationReusedError,
  InvalidTournamentRoomRequestError,
} from '../../../application/errors/TournamentRoomErrors'
import {
  AccountProfileMissingError,
  PlayerWithoutEquippedHeroError,
  UpstreamServiceError,
} from '../../../application/errors/UpstreamErrors'
import type { BattleRoomDto } from '../../../application/dto/BattleRoomDto'
import type { TournamentRoomRecordDto } from '../../../application/dto/TournamentRoomRecordDto'
import type { CreateTournamentRoom } from '../../../application/use-cases/CreateTournamentRoom'
import type { StartTournamentRoom } from '../../../application/use-cases/StartTournamentRoom'
import type { GetTournamentRoomRecord } from '../../../application/use-cases/GetTournamentRoomRecord'
import { InternalOnly, InternalServices } from './auth/decorators'
import {
  tournamentRoomAfterSeqOf,
  tournamentRoomCreateRequestOf,
  tournamentRoomIntentOf,
  tournamentRoomStartRequestOf,
} from './tournament-room-request'
import { CREATE_TOURNAMENT_ROOM, GET_TOURNAMENT_ROOM_RECORD, START_TOURNAMENT_ROOM } from './tokens'

/**
 * Salas de combate que el servicio Tournament reserva para cada justa
 * (Management#517, EN de `tournament-rooms`; HU-83/HU-85 de Tournament,
 * Management#465/#470). Rutas internas HMAC -- `@InternalOnly()`, el MISMO
 * guard generico que `MissionSimulationsController` -- consumidas
 * EXCLUSIVAMENTE por el servicio Tournament, nunca por un cliente con
 * testimonio de jugador.
 *
 * NO REIMPLEMENTA NADA DEL MOTOR DE COMBATE: crea el roster fijo y delega el
 * resto (validaciones, compromisos, aleatoriedad, turnos, finalizacion) en
 * los mismos casos de uso que el lobby publico ya tiene.
 */
@ApiTags('combat-internal')
@ApiHeader({ name: 'x-internal-service', required: true, description: 'tournament' })
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@InternalOnly()
@InternalServices('tournament')
@Controller('internal/v1/combat/tournament-rooms')
export class TournamentRoomController {
  constructor(
    @Inject(CREATE_TOURNAMENT_ROOM) private readonly createRoom: CreateTournamentRoom,
    @Inject(START_TOURNAMENT_ROOM) private readonly startRoom: StartTournamentRoom,
    @Inject(GET_TOURNAMENT_ROOM_RECORD) private readonly getRecord: GetTournamentRoomRecord,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reserva una justa SOLO/DUO/TRIO con 2/4/6 humanos',
    description:
      'Contrato v3: contractVersion=3, mode y teamSize; sin estos campos conserva DUO historico. ' +
      'Idempotente por operationId e intencion normalizada v3 (cuerpo original historico). ' +
      'Una intencion distinta responde 409. Resuelve displayName ' +
      '(Account) y heroe equipado (Player-Inventory) de cada humano contra los ' +
      'mismos puertos que usa el lobby publico. La sala nace PREPARING, fuera del listado ' +
      'publico y sin admitir join/leave/cancel del lobby.',
  })
  @ApiResponse({ status: 201, description: 'Sala creada (o ya existente, mismo operationId)' })
  @ApiResponse({ status: 400, description: 'Cuerpo invalido (formato/tipo)' })
  @ApiResponse({ status: 401, description: 'Llamada interna no autorizada' })
  @ApiResponse({
    status: 409,
    description: 'El operationId ya se uso con un cuerpo distinto',
  })
  @ApiResponse({
    status: 422,
    description:
      'Roster invalido (tamano incorrecto para la modalidad o humano repetido) o sin heroe ' +
      'equipado',
  })
  @ApiResponse({ status: 503, description: 'Account o Player-Inventory no respondieron' })
  async create(@Body() body: unknown): Promise<BattleRoomDto> {
    try {
      const request = tournamentRoomCreateRequestOf(body)
      const intent = tournamentRoomIntentOf(body, request)

      return await this.createRoom.execute(request, intent.hash, intent.version)
    } catch (error: unknown) {
      throw TournamentRoomController.translate(error)
    }
  }

  @Post(':roomId/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inicia la batalla de una sala de torneo ya creada',
    description:
      'Reutiliza TAL CUAL las validaciones, compromisos, aleatoriedad, motor de turnos y ' +
      'finalizacion que Combat ya tiene (StartBattle). Idempotente incluso despues de FINISHED: ' +
      'reenviarlo devuelve la misma sala sin crear un segundo combate. No depende de transmisor ' +
      'ni de video.',
  })
  @ApiResponse({ status: 200, description: 'Batalla iniciada (o sala ya iniciada/terminada)' })
  @ApiResponse({ status: 400, description: 'roomId no es un UUID v4 valido, o cuerpo invalido' })
  @ApiResponse({ status: 401, description: 'Llamada interna no autorizada' })
  @ApiResponse({ status: 404, description: 'La sala no existe, o no es una sala de torneo' })
  @ApiResponse({
    status: 409,
    description: 'tournamentId/encounterId no coinciden con los de la sala, o conflicto de version',
  })
  @ApiResponse({
    status: 422,
    description: 'Un participante ya no es elegible (blockers[]) o no tiene heroe equipado',
  })
  @ApiResponse({ status: 503, description: 'Player-Inventory no respondio' })
  async start(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Body() body: unknown,
  ): Promise<BattleRoomDto> {
    try {
      const request = tournamentRoomStartRequestOf(body)

      return await this.startRoom.execute(roomId, request)
    } catch (error: unknown) {
      throw TournamentRoomController.translate(error)
    }
  }

  @Get(':roomId/record')
  @ApiOperation({
    summary: 'Lee, paginada, el registro de eventos de una sala de torneo',
    description:
      'Hasta 100 eventos con secuencia consecutiva desde afterSeq + 1. Lectura pura: nunca ' +
      'reescribe ni recalcula eventos. Funciona tambien despues de que la sala termino.',
  })
  @ApiResponse({ status: 200, description: 'Pagina del registro' })
  @ApiResponse({ status: 400, description: 'roomId no es UUID v4, o afterSeq no es valido' })
  @ApiResponse({ status: 401, description: 'Llamada interna no autorizada' })
  @ApiResponse({ status: 404, description: 'La sala no existe, o no es una sala de torneo' })
  async record(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Query('afterSeq') afterSeqRaw?: string,
  ): Promise<TournamentRoomRecordDto> {
    try {
      const afterSeq = tournamentRoomAfterSeqOf(afterSeqRaw)

      return await this.getRecord.execute(roomId, afterSeq)
    } catch (error: unknown) {
      throw TournamentRoomController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof InvalidTournamentRoomRequestError) {
      return new BadRequestException({
        statusCode: 400,
        code: 'SCHEMA_INVALID',
        message: error.message,
      })
    }

    if (error instanceof RoomNotFoundError || error instanceof NotATournamentRoomError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof RoomAccessForbiddenError) {
      return new ForbiddenException(error.message)
    }

    if (
      error instanceof TournamentRoomOperationReusedError ||
      error instanceof TournamentRoomMismatchError
    ) {
      return new ConflictException({
        statusCode: 409,
        code: 'OPERATION_ID_REUSED',
        message: error.message,
      })
    }

    if (
      error instanceof RoomConflictError ||
      error instanceof RoomNotStartableError ||
      error instanceof BattleNotInProgressError ||
      error instanceof NotYourTurnError
    ) {
      return new ConflictException(error.message)
    }

    if (error instanceof InvalidTournamentRosterError) {
      return new UnprocessableEntityException(error.message)
    }

    if (error instanceof UnsupportedTeamCompositionError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: error.message,
        code: error.code,
      })
    }

    if (error instanceof PlayerWithoutEquippedHeroError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: error.message,
        code: error.code,
      })
    }

    if (error instanceof PrecombatEligibilityBlockedError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: error.message,
        blockers: error.blockers,
      })
    }

    if (error instanceof AccountProfileMissingError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Account no tiene un perfil asociado a uno de los jugadores del roster.',
        code: 'ACCOUNT_PROFILE_NOT_FOUND',
      })
    }

    if (error instanceof UpstreamServiceError) {
      return new ServiceUnavailableException(
        'El servicio no pudo completar la operacion porque una dependencia interna no respondio.',
      )
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
