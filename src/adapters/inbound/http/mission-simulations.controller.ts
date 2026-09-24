import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  InvalidMissionSimulationRequestError,
  MissionSimulationOperationReusedError,
} from '../../../application/errors/MissionSimulationIntakeErrors'
import { AcceptMissionSimulationRequest } from '../../../application/use-cases/AcceptMissionSimulationRequest'
import { canonicalBodyHash } from '../../outbound/identity/internal-signature'
import { InternalOnly } from './auth/decorators'
import { missionSimulationOperationIdOf } from './mission-simulation-request'
import { ACCEPT_MISSION_SIMULATION_REQUEST } from './tokens'

/**
 * Signed, durable intake for HU-72. It deliberately cannot return a fabricated
 * combat result: the simulation engine and mission content are still pending.
 */
@ApiTags('combat-internal')
@ApiHeader({ name: 'x-internal-service', required: true, description: 'missions' })
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@InternalOnly()
@Controller('internal/v1/combat/simulations')
export class MissionSimulationsController {
  constructor(
    @Inject(ACCEPT_MISSION_SIMULATION_REQUEST)
    private readonly accept: AcceptMissionSimulationRequest,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recibe una solicitud de simulacion de Missions (HU-72)',
    description:
      'Valida y reserva operationId. Hasta integrar el motor real responde 503; ' +
      'la misma solicitud puede reintentarse y otra con el mismo operationId recibe 409.',
  })
  async simulate(@Body() body: unknown): Promise<never> {
    try {
      const operationId = missionSimulationOperationIdOf(body)
      const requestHash = canonicalBodyHash(body)
      await this.accept.execute(operationId, requestHash)
    } catch (error: unknown) {
      if (error instanceof InvalidMissionSimulationRequestError) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'SCHEMA_INVALID',
          message: error.message,
        })
      }
      if (error instanceof MissionSimulationOperationReusedError) {
        throw new ConflictException({
          statusCode: 409,
          code: 'OPERATION_ID_REUSED',
          message: error.message,
        })
      }
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'SIMULATION_UNAVAILABLE',
        message: 'Combat no puede registrar la simulacion ahora. Reintente la misma operacion.',
      })
    }

    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'SIMULATION_UNAVAILABLE',
      message: 'El motor de simulacion de misiones aun no esta disponible.',
    })
  }
}
