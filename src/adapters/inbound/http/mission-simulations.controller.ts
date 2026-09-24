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
import {
  DEFAULT_ESTIMATE_RUNS,
  EstimateMissionOutcome,
  MAX_ESTIMATE_RUNS,
  type MissionEstimate,
} from '../../../application/use-cases/EstimateMissionOutcome'
import { RunMissionSimulation } from '../../../application/use-cases/RunMissionSimulation'
import type {
  MissionSimulationRequest,
  MissionSimulationResult,
} from '../../../application/services/MissionSimulation'
import { canonicalBodyHash } from '../../outbound/identity/internal-signature'
import { InternalOnly } from './auth/decorators'
import {
  MissionSimulationContentError,
  missionSimulationRequestOf,
} from './mission-simulation-request'
import {
  ACCEPT_MISSION_SIMULATION_REQUEST,
  ESTIMATE_MISSION_OUTCOME,
  RUN_MISSION_SIMULATION,
} from './tokens'

const schemaInvalid = (message: string): BadRequestException =>
  new BadRequestException({ statusCode: 400, code: 'SCHEMA_INVALID', message })

/** La solicitud de simulacion validada, con los codigos 400 y 422 del contrato. */
const parseRequest = (body: unknown): MissionSimulationRequest => {
  try {
    return missionSimulationRequestOf(body)
  } catch (error: unknown) {
    if (error instanceof InvalidMissionSimulationRequestError) {
      throw schemaInvalid(error.message)
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
}

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
    @Inject(ESTIMATE_MISSION_OUTCOME)
    private readonly estimateOutcome: EstimateMissionOutcome,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recibe una solicitud de simulacion de Missions (HU-72)',
    description:
      'Valida el contenido, simula y persiste el resultado. Un reintento devuelve el mismo resultado.',
  })
  async simulate(@Body() body: unknown): Promise<MissionSimulationResult> {
    const request = parseRequest(body)
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

  /**
   * Probabilidad de exito antes de matricular (diseno «misiones jugables», P-J7).
   * Cuerpo `{ runs?, request }`: `request` es la misma solicitud de simulacion y
   * `runs` las corridas (30 por defecto, maximo 100). No reserva la operacion ni
   * guarda nada; tambien dice que habilidades del heroe sirven en misiones.
   */
  @Post('estimates')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Estima la probabilidad de exito de una mision sin guardar nada',
  })
  estimate(@Body() body: unknown): MissionEstimate {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw schemaInvalid('El cuerpo debe ser un objeto con "request".')
    }
    const { runs = DEFAULT_ESTIMATE_RUNS, request } = body as {
      readonly runs?: unknown
      readonly request?: unknown
    }
    if (
      typeof runs !== 'number' ||
      !Number.isInteger(runs) ||
      runs < 1 ||
      runs > MAX_ESTIMATE_RUNS
    ) {
      throw schemaInvalid(`"runs" debe ser un entero entre 1 y ${String(MAX_ESTIMATE_RUNS)}.`)
    }
    const parsed = parseRequest(request)
    try {
      return this.estimateOutcome.execute(parsed, runs)
    } catch {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ESTIMATE_UNAVAILABLE',
        message: 'Combat no puede estimar esta mision ahora.',
      })
    }
  }
}
