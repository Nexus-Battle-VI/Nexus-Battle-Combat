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
  BattleNotInProgressError,
  InvalidBattleRosterError,
  NotYourTurnError,
  RoomNotStartableError,
  UnsupportedTeamCompositionError,
} from '../../../domain/errors/BattleErrors'
import {
  DuplicateDisplayNameError,
  InvalidModeCompositionError,
  InvalidRewardError,
  InvalidRoomCapacityError,
  InvalidTeamCapacityError,
  PlayerAlreadyJoinedError,
  PlayerNotInRoomError,
  RoomCancellationForbiddenError,
  RoomFullError,
  RoomNotCancellableError,
  RoomNotJoinableError,
  RoomNotLeavableError,
} from '../../../domain/errors/BattleRoomErrors'
import {
  RoomAccessForbiddenError,
  RoomConflictError,
  RoomNotFoundError,
} from '../../../application/errors/ApplicationError'
import { PrecombatEligibilityBlockedError } from '../../../application/errors/PrecombatEligibilityError'
import {
  StakeOperationConflictError,
  StakeRejectedError,
} from '../../../application/errors/StakeIntegrationErrors'
import {
  InvalidStakeAmountError,
  StakeNotAllowedInPveError,
} from '../../../domain/errors/StakeErrors'
import {
  AccountProfileMissingError,
  PlayerWithoutEquippedHeroError,
  UpstreamServiceError,
} from '../../../application/errors/UpstreamErrors'
import type { BattleRoomDto } from '../../../application/dto/BattleRoomDto'
import type { CancelBattleRoom } from '../../../application/use-cases/CancelBattleRoom'
import type { CreateBattleRoom } from '../../../application/use-cases/CreateBattleRoom'
import type { GetBattleRoom } from '../../../application/use-cases/GetBattleRoom'
import type { StartBattle } from '../../../application/use-cases/StartBattle'
import type { JoinBattleRoom } from '../../../application/use-cases/JoinBattleRoom'
import type { LeaveBattleRoom } from '../../../application/use-cases/LeaveBattleRoom'
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
  GET_BATTLE_ROOM,
  JOIN_BATTLE_ROOM,
  LEAVE_BATTLE_ROOM,
  LIST_AVAILABLE_BATTLE_ROOMS,
  START_BATTLE,
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
    @Inject(LEAVE_BATTLE_ROOM) private readonly leaveBattleRoom: LeaveBattleRoom,
    @Inject(GET_BATTLE_ROOM) private readonly getBattleRoom: GetBattleRoom,
    @Inject(START_BATTLE) private readonly startBattle: StartBattle,
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
  async list(@CurrentIdentity() identity: VerifiedIdentity): Promise<readonly BattleRoomDto[]> {
    // HU-23 (§10): la apuesta que viaja es la del PROPIO jugador; por eso el
    // listado necesita la identidad (ya la exige el guard global).
    return this.listAvailableBattleRooms.execute(identity.subject)
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
      'WAITING_FOR_PLAYERS -> PREPARING, persistencia con bloqueo optimista, y (HU-16, RF-16) ' +
      'elegibilidad precombate del heroe equipado para esta sala concreta: readiness de ' +
      'Player-Inventory reenviada sin reinterpretar, y restriccion de clase (Chaman/Medico) ' +
      'segun el formato derivado de la sala. ' +
      'LIMITACIONES CONOCIDAS que persisten, documentadas explicitamente (no errores ocultos): ' +
      'nivel de heroe, nivel minimo de sala y mision activa (DP-2/DP-3/DP-4 de la auditoria ' +
      'HU-16.1) siguen sin implementarse porque ningun servicio confirma hoy una fuente ' +
      'autoritativa real -- no se inventan aqui; ver docs/hu-16-precombat-eligibility.md.',
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
      'El jugador no tiene un heroe equipado en Player-Inventory (code: HERO_NOT_SELECTED), el ' +
      'heroe equipado no es elegible para esta sala (readiness=false y/o clase no permitida en ' +
      'el formato de la sala; cuerpo con `blockers[]`, HU-16), o el sujeto verificado no tiene ' +
      'cuenta en Account todavia (code: ACCOUNT_PROFILE_NOT_FOUND, HU-15.4)',
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
      const dto = await this.joinBattleRoom.execute(
        roomId,
        identity.subject,
        body.team ?? null,
        body.stake ?? null,
      )

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

  @Post(':roomId/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abandona una sala propia como participante (ciclo de vida del lobby, HU-15.2)',
    description:
      'Libera el cupo del jugador autenticado. Aplica igual al propietario que a cualquier ' +
      'otro participante -- distinto de `cancel`, que es exclusivo del creador y afecta a la ' +
      'sala entera. Si la sala estaba PREPARING (llena) y este abandono libera cupo, vuelve a ' +
      'WAITING_FOR_PLAYERS en la misma mutacion.',
  })
  @ApiResponse({ status: 200, type: BattleRoomResponse })
  @ApiResponse({ status: 400, description: 'roomId no es un UUID v4 valido' })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({ status: 404, description: 'La sala no existe' })
  @ApiResponse({
    status: 409,
    description:
      'El jugador no es participante de la sala, la sala ya esta CANCELLED, o conflicto de ' +
      'version (bloqueo optimista)',
  })
  async leave(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<BattleRoomDto> {
    try {
      const dto = await this.leaveBattleRoom.execute(roomId, identity.subject)

      this.notifyRoomUpdated(dto)

      return dto
    } catch (error: unknown) {
      throw BattleRoomController.translate(error)
    }
  }

  @Get(':roomId')
  @ApiOperation({
    summary: 'Lee una sala y, si esta en curso, su batalla (solo participantes; HU-17)',
    description:
      'GET /rooms solo lista salas WAITING_FOR_PLAYERS: en cuanto una sala pasa a PREPARING o ' +
      'IN_BATTLE este es el unico modo HTTP de leerla. La identidad sale del testimonio.',
  })
  @ApiResponse({ status: 200, type: BattleRoomResponse })
  @ApiResponse({ status: 400, description: 'roomId no es un UUID v4 valido' })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({ status: 403, description: 'Quien pide no es participante de la sala' })
  @ApiResponse({ status: 404, description: 'La sala no existe' })
  async read(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<BattleRoomDto> {
    try {
      return await this.getBattleRoom.execute(roomId, identity.subject)
    } catch (error: unknown) {
      throw BattleRoomController.translate(error)
    }
  }

  @Post(':roomId/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inicia la batalla de una sala PREPARING (HU-17, RF-17)',
    description:
      'Sin cuerpo: ningun cliente elige quien inicia ni quien participa. Cualquier participante ' +
      'HUMAN puede invocarlo. Revalida la elegibilidad precombate (HU-16) de cada participante, ' +
      'genera la cola de turnos con el motor centralizado (HU-24), la persiste y solo entonces ' +
      'difunde battleStarted por WebSocket. IDEMPOTENTE: si la sala ya esta IN_BATTLE devuelve el ' +
      'estado vigente sin generar otra cola ni otro evento.',
  })
  @ApiResponse({ status: 200, type: BattleRoomResponse })
  @ApiResponse({ status: 400, description: 'roomId no es un UUID v4 valido' })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({ status: 403, description: 'Quien pide no es participante de la sala' })
  @ApiResponse({ status: 404, description: 'La sala no existe' })
  @ApiResponse({
    status: 409,
    description: 'La sala no esta PREPARING ni IN_BATTLE, o conflicto de version',
  })
  @ApiResponse({
    status: 422,
    description:
      'Un participante ya no es elegible (blockers[]: HERO_CHANGED_SINCE_JOIN, HERO_LOADOUT_CHANGED, ' +
      'readiness, formato) o no tiene heroe equipado (code: HERO_NOT_SELECTED). No hay cola ni evento.',
  })
  @ApiResponse({ status: 503, description: 'Player-Inventory no respondio de verdad' })
  async start(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<BattleRoomDto> {
    try {
      const dto = await this.startBattle.execute(roomId, identity.subject)

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

    if (
      error instanceof RoomCancellationForbiddenError ||
      error instanceof RoomAccessForbiddenError
    ) {
      return new ForbiddenException(error.message)
    }

    if (
      error instanceof RoomNotCancellableError ||
      error instanceof RoomConflictError ||
      error instanceof RoomNotJoinableError ||
      error instanceof RoomFullError ||
      error instanceof PlayerAlreadyJoinedError ||
      error instanceof DuplicateDisplayNameError ||
      error instanceof PlayerNotInRoomError ||
      error instanceof RoomNotLeavableError ||
      error instanceof RoomNotStartableError ||
      error instanceof BattleNotInProgressError ||
      error instanceof NotYourTurnError
    ) {
      return new ConflictException(error.message)
    }

    if (
      error instanceof InvalidTeamCapacityError ||
      error instanceof InvalidRoomCapacityError ||
      error instanceof InvalidModeCompositionError ||
      error instanceof InvalidRewardError ||
      error instanceof InvalidBattleRosterError
    ) {
      return new UnprocessableEntityException(error.message)
    }

    // HU-16.1 (DP-7, hallazgo de la auditoria): antes caia en el 422 generico
    // de arriba, sin `code` -- indistinguible en el cuerpo de cualquier otro
    // 422. Mismo patron que `AccountProfileMissingError` de mas abajo.
    // HU-17: equipos de distinto tamano. `code` estable para que Web lo distinga
    // de "un participante ya no cumple los requisitos" (mismo 422).
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

    // HU-16 (RF-16, Management#25/#401/#402). El jugador SI tiene un heroe
    // equipado (a diferencia del caso de arriba), pero no es elegible para
    // ESTA sala: `blockers` viaja completo, sin colapsar a un unico `code`,
    // porque pueden concurrir varios motivos a la vez (mismo patron que
    // `HeroReadiness.blockers[].code` de Player-Inventory).
    if (error instanceof PrecombatEligibilityBlockedError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: error.message,
        blockers: error.blockers,
      })
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

    // HU-23 (contrato §11): apuesta en una sala PVE (D4) y monto invalido.
    // Se comprueban ANTES del `DomainError` generico: ambos extienden de el.
    if (error instanceof StakeNotAllowedInPveError || error instanceof InvalidStakeAmountError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: error.message,
        code: error.code,
      })
    }

    // HU-23: Wallet rechazo la reserva (422) con su propio codigo del §11 --
    // `INSUFFICIENT_AVAILABLE_BALANCE` viaja TAL CUAL (contrato §7: la
    // creacion completa falla con el mismo codigo).
    if (error instanceof StakeRejectedError) {
      return new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: error.message,
        ...(error.code === null ? {} : { code: error.code }),
      })
    }

    if (error instanceof StakeOperationConflictError) {
      return new ConflictException(error.message)
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
