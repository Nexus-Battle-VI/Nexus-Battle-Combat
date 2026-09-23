import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  DuplicateDefeatError,
  ExperienceRollOperationReusedError,
  InvalidExperienceRollRequestError,
} from '../../../application/errors/ExperienceRollErrors'
import {
  EXPERIENCE_ROLLS_SCHEMA_VERSION,
  ResolveExperienceRolls,
  type ResolveExperienceRollsResult,
} from '../../../application/use-cases/ResolveExperienceRolls'
import { ExperienceRollMappingError } from '../../outbound/persistence/experience-roll-mapping'
import { InternalOnly } from './auth/decorators'
import { ExperienceRollsRequest, ExperienceRollsResponse } from './experience-rolls.dto'
import { RESOLVE_EXPERIENCE_ROLLS } from './tokens'

/**
 * Tiradas de experiencia de una mision (HU-09, Task HU-09.2;
 * `hu-09-experience-reward-v1` §5.2).
 *
 * SERVICIO A SERVICIO, NUNCA AL CLIENTE: `@InternalOnly()` exime del testimonio
 * JWT y la llama el guard con firma HMAC. `INTERNAL_CALLERS` (global en Combat)
 * ya trae `missions`: NO se amplia ni se anade un mecanismo por ruta, que en
 * este servicio no existe (el `@InternalCallers` por ruta es de
 * Player/Inventory).
 *
 * NO EXPONE ALEATORIEDAD, que es lo que `ADR-021` prohibe: no acepta un rango,
 * no devuelve el indice ni la semilla y no es parametrizable. Recibe QUE
 * rivales cayeron -- instancia a instancia -- y devuelve la cara del dado de
 * cada uno; el importe de experiencia es de Missions.
 *
 * LAS TIRADAS SE PERSISTEN ANTES DE RESPONDER: un reintento con el mismo
 * `operationId` devuelve las MISMAS tiradas con `applied: false`, sin volver a
 * consumir el cursor de azar.
 */
@ApiTags('combat-internal')
@ApiHeader({ name: 'x-internal-service', required: true, description: 'Siempre `missions`.' })
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@InternalOnly()
@Controller('internal/v1/combat/experience-rolls')
export class ExperienceRollsController {
  constructor(
    @Inject(RESOLVE_EXPERIENCE_ROLLS)
    private readonly resolveExperienceRolls: ResolveExperienceRolls,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resuelve una tirada 1d8 por cada NPC derrotado en la mision (HU-09)',
    description:
      'Idempotente por `operationId` (`mission:{enrollmentId}:xp-rolls`): un reintento con el ' +
      'mismo cuerpo devuelve las mismas tiradas y `applied: false`. Con otra lista de derrotas ' +
      'responde 409 y NUNCA sobrescribe el lote guardado.',
  })
  @ApiOkResponse({ type: ExperienceRollsResponse })
  async resolve(@Body() body: ExperienceRollsRequest): Promise<ExperienceRollsResponse> {
    try {
      return toResponse(await this.resolveExperienceRolls.execute(body))
    } catch (error: unknown) {
      throw ExperienceRollsController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof InvalidExperienceRollRequestError) {
      return new BadRequestException({
        statusCode: 400,
        message: error.message,
        code: 'SCHEMA_INVALID',
      })
    }

    if (error instanceof DuplicateDefeatError) {
      return new UnprocessableEntityException({
        statusCode: 422,
        message: error.message,
        code: 'DUPLICATE_DEFEAT',
      })
    }

    if (error instanceof ExperienceRollOperationReusedError) {
      return new ConflictException({
        statusCode: 409,
        message: error.message,
        code: 'OPERATION_ID_REUSED',
      })
    }

    // El lote guardado no se puede leer (documento incoherente). NO es culpa de
    // quien llama y reintentar con el mismo `operationId` no empeora nada: se
    // responde lo unico que el contrato permite prometer, que Combat no puede
    // atender ahora. Jamás se devuelven tiradas nuevas para taparlo.
    if (error instanceof ExperienceRollMappingError) {
      return new ServiceUnavailableException({
        statusCode: 503,
        message: error.message,
        code: 'ROLL_UNAVAILABLE',
      })
    }

    // Cualquier otro fallo -- y en particular la Base inalcanzable -- es el
    // `503 ROLL_UNAVAILABLE` del contrato: `ROLL_UNAVAILABLE` significa
    // exactamente "reintenta con el MISMO operationId", y un 500 le diria a
    // Missions que marque `FAILED` y alerte por algo que se resuelve
    // reintentando. Mismo criterio que `InventoryGrantsController` en
    // Player/Inventory.
    return new ServiceUnavailableException({
      statusCode: 503,
      message: 'No se pudieron resolver las tiradas. Reintente con la misma operacion.',
      code: 'ROLL_UNAVAILABLE',
    })
  }
}

const toResponse = (result: ResolveExperienceRollsResult): ExperienceRollsResponse => ({
  schemaVersion: EXPERIENCE_ROLLS_SCHEMA_VERSION,
  operationId: result.operationId,
  applied: result.applied,
  // `rivalRef` NO viaja: el contrato §5.2 declara exactamente estos cuatro
  // campos por tirada, y anadir uno seria inventar contrato.
  rolls: result.defeats.map((defeat) => ({
    encounterId: defeat.encounterId,
    enemyInstanceId: defeat.enemyInstanceId,
    roll: defeat.roll,
    persistedAt: defeat.persistedAt.toISOString(),
  })),
})
