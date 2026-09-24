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
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  InvalidMissionSimulationRequestError,
  MissionSimulationOperationReusedError,
} from '../../../application/errors/MissionSimulationIntakeErrors'
import { AcceptMissionSimulationRequest } from '../../../application/use-cases/AcceptMissionSimulationRequest'
import { RunMissionSimulation } from '../../../application/use-cases/RunMissionSimulation'
import type { MissionSimulationResult } from '../../../application/services/MissionSimulation'
import { canonicalBodyHash } from '../../outbound/identity/internal-signature'
import { InternalOnly } from './auth/decorators'
import {
  MissionSimulationContentError,
  missionSimulationRequestOf,
} from './mission-simulation-request'
import { ACCEPT_MISSION_SIMULATION_REQUEST, RUN_MISSION_SIMULATION } from './tokens'

/**
 * Signed, durable mission simulation. The response is persisted before 200.
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
    @Inject(RUN_MISSION_SIMULATION)
    private readonly run: RunMissionSimulation,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recibe una solicitud de simulacion de Missions (HU-72)',
    description:
      'Valida el contenido, simula y persiste el resultado. Un reintento devuelve el mismo resultado.',
  })
  async simulate(@Body() body: unknown): Promise<MissionSimulationResult> {
    let request
    try {
      request = missionSimulationRequestOf(body)
    } catch (error: unknown) {
      if (error instanceof InvalidMissionSimulationRequestError) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'SCHEMA_INVALID',
          message: error.message,
        })
      }
      if (error instanceof MissionSimulationContentError) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'MISSION_CONTENT_INVALID',
          message: error.message,
        })
      }
      throw error
    }
    try {
      const requestHash = canonicalBodyHash(body)
      await this.accept.execute(request.operationId, requestHash)
      return await this.run.execute(request, requestHash)
    } catch (error: unknown) {
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
  }
}
