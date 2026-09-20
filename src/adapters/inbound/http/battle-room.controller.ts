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
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  DuplicateDisplayNameError,
  InvalidModeCompositionError,
  InvalidRewardError,
  InvalidRoomCapacityError,
  InvalidTeamCapacityError,
  PlayerAlreadyJoinedError,
  RoomCancellationForbiddenError,
  RoomFullError,
  RoomNotCancellableError,
  RoomNotJoinableError,
} from '../../../domain/errors/BattleRoomErrors'
import { RoomConflictError, RoomNotFoundError } from '../../../application/errors/ApplicationError'
import {
  AccountProfileMissingError,
  PlayerWithoutEquippedHeroError,
  UpstreamServiceError,
} from '../../../application/errors/UpstreamErrors'
import type { BattleRoomDto } from '../../../application/dto/BattleRoomDto'
import type { CancelBattleRoom } from '../../../application/use-cases/CancelBattleRoom'
import type { CreateBattleRoom } from '../../../application/use-cases/CreateBattleRoom'
import type { JoinBattleRoom } from '../../../application/use-cases/JoinBattleRoom'
import type { ListAvailableBattleRooms } from '../../../application/use-cases/ListAvailableBattleRooms'
import {
  REALTIME_NOTIFIER,
  type RealtimeNotifierPort,
} from '../../../application/ports/RealtimeNotifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CurrentIdentity } from './auth/decorators'
import {
  BattleRoomResponse,
  CreateBattleRoomRequest,
  JoinBattleRoomRequest,
} from './battle-room.dto'
import {
  CANCEL_BATTLE_ROOM,
  CREATE_BATTLE_ROOM,
  JOIN_BATTLE_ROOM,
  LIST_AVAILABLE_BATTLE_ROOMS,
} from './tokens'

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
    @Inject(JOIN_BATTLE_ROOM) private readonly joinBattleRoom: JoinBattleRoom,
    @Inject(REALTIME_NOTIFIER) private readonly realtime: RealtimeNotifierPort,
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
      const dto = await this.cancelBattleRoom.execute(roomId, identity.subject)

      this.notifyRoomUpdated(dto)

      return dto
    } catch (error: unknown) {
      throw BattleRoomController.translate(error)
    }
  }

  @Post(':roomId/join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Une al jugador autenticado a una sala en WAITING_FOR_PLAYERS (HU-15.2, RF-15)',
    description:
      'Fase de integracion cross-service de RF-15 (repo 3/4, Account y Player-Inventory ya ' +
      'publicaron su contrato interno): ingreso de jugador autenticado, resolucion autoritativa ' +
      'de `displayName` (Account, DP-2) y `heroId` (Player-Inventory, DP-4) via HTTP interno ' +
      'firmado HMAC -- nunca del cuerpo de la peticion -- unicidad de nombre dentro de la sala, ' +
      'seleccion/asignacion de equipo, cupo, jugador duplicado, transicion ' +
      'WAITING_FOR_PLAYERS -> PREPARING, persistencia con bloqueo optimista. ' +
      'LIMITACION CONOCIDA que persiste, documentada explicitamente (no un error oculto): DP-3 ' +
      '(nivel de heroe) sigue sin implementarse porque Player-Inventory confirmo que ese dato ' +
      'no existe en su dominio -- no se inventa aqui; trazado hacia HU-15.4.',
  })
  @ApiResponse({ status: 200, type: BattleRoomResponse })
  @ApiResponse({
    status: 400,
    description: 'roomId no es un UUID v4 valido, o el cuerpo trae un campo invalido/no declarado',
  })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({ status: 404, description: 'La sala no existe' })
  @ApiResponse({
    status: 409,
    description:
      'La sala no esta en WAITING_FOR_PLAYERS (CANCELLED o PREPARING), el equipo objetivo no ' +
      'tiene cupo, el jugador ya es participante de la sala, el nombre resuelto de Account ya lo ' +
      'usa otro participante de la sala, o conflicto de version (bloqueo optimista)',
  })
  @ApiResponse({
    status: 422,
    description:
      'El jugador no tiene un heroe equipado en Player-Inventory (DP-4), o el sujeto ' +
      'verificado no tiene cuenta en Account todavia (code: ACCOUNT_PROFILE_NOT_FOUND, HU-15.4)',
  })
  @ApiResponse({
    status: 503,
    description:
      'Account o Player-Inventory no respondieron de verdad (no alcanzable, tiempo agotado, ' +
      '401, 5xx, respuesta con forma invalida)',
  })
  async join(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Body() body: JoinBattleRoomRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<BattleRoomDto> {
    try {
      const dto = await this.joinBattleRoom.execute(roomId, identity.subject, body.team ?? null)

      // Un solo evento cubre tanto "ingreso valido" como "transicion a
      // PREPARING": ambos son el MISMO resultado de la MISMA mutacion
      // (BattleRoom.join() decide PREPARING en la misma escritura), asi que
      // el payload que ya trae `dto.status` es suficiente -- no hace falta
      // un segundo evento distinto para la transicion de estado.
      this.notifyRoomUpdated(dto)

      return dto
    } catch (error: unknown) {
      throw BattleRoomController.translate(error)
    }
  }

  /**
   * Notifica `battle-room.updated` (HU-15.2, ADR-020) DESPUES de que
   * `repository.save()` ya persistio -- nunca antes: el controlador no
   * conoce reglas de negocio, solo reenvia el resultado ya confirmado del
   * caso de uso. Un fallo al notificar (p. ej. el gateway aun no acepta
   * conexiones) NO REVIENTA LA PETICION HTTP: la mutacion ya esta
   * persistida y es el resultado que importa; la notificacion es una
   * mejora de experiencia, no la fuente de verdad (esa es
   * `GET /v1/combat/rooms`, igual que antes de esta ampliacion).
   */
  private notifyRoomUpdated(dto: BattleRoomDto): void {
    try {
      this.realtime.notifyRoomUpdated({ roomId: dto.id, status: dto.status, version: dto.version })
    } catch {
      // No se traduce ni se propaga: ver el comentario del metodo.
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof RoomNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof RoomCancellationForbiddenError) {
      return new ForbiddenException(error.message)
    }

    if (
      error instanceof RoomNotCancellableError ||
      error instanceof RoomConflictError ||
      error instanceof RoomNotJoinableError ||
      error instanceof RoomFullError ||
      error instanceof PlayerAlreadyJoinedError ||
      error instanceof DuplicateDisplayNameError
    ) {
      return new ConflictException(error.message)
    }

    if (
      error instanceof InvalidTeamCapacityError ||
      error instanceof InvalidRoomCapacityError ||
      error instanceof InvalidModeCompositionError ||
      error instanceof InvalidRewardError ||
      error instanceof PlayerWithoutEquippedHeroError
    ) {
      return new UnprocessableEntityException(error.message)
    }

    // HU-15.4 (hallazgo de validacion integral): Account SI respondio (404
    // real, no un fallo de transporte) diciendo que el sujeto verificado no
    // tiene cuenta todavia. Es informacion de negocio diagnosticable, no una
    // caida de Account -- 422 con un `code` estructurado para que Web pueda
    // distinguirlo de "falta heroe equipado" (mismo status 422) sin
    // depender de texto libre, y para que NUNCA se confunda con el 503 de
    // `UpstreamServiceError` de mas abajo. Ver `AccountProfileMissingError`
    // en `application/errors/UpstreamErrors.ts`.
    if (error instanceof AccountProfileMissingError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message:
          'No encontramos una cuenta asociada a tu sesion. Cierra sesion y vuelve a iniciar sesion; ' +
          'si el problema persiste, contacta a soporte.',
        code: 'ACCOUNT_PROFILE_NOT_FOUND',
      })
    }

    // HU-15.2 (RF-15): las llamadas internas a Account/Player-Inventory
    // fallaron de verdad (no alcanzable, tiempo agotado, 401, 5xx, forma
    // invalida de la respuesta). 503, no 500: Combat identifica la causa
    // como una dependencia externa que no respondio, no un fallo propio no
    // clasificado. Distinto de `AccountProfileMissingError` arriba: ahi
    // Account SI respondio, con un 404 valido segun su propio contrato.
    if (error instanceof UpstreamServiceError) {
      return new ServiceUnavailableException(
        'El servicio no pudo completar el ingreso porque una dependencia interna no respondio.',
      )
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
