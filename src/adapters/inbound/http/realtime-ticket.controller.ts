import { Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger'

import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { IssueRealtimeTicket } from '../../../application/use-cases/RealtimeTickets'
import { CurrentIdentity } from './auth/decorators'
import { ISSUE_REALTIME_TICKET } from './tokens'

class RealtimeTicketResponse {
  @ApiProperty({
    description: 'Ticket opaco de un solo uso. Se envia como primer mensaje del WebSocket.',
  })
  readonly ticket!: string

  @ApiProperty({ example: 30 })
  readonly expiresInSeconds!: number
}

/**
 * Ticket de un solo uso para abrir el WebSocket (ADR-020).
 *
 * Un navegador no puede fijar `Authorization` al abrir un WebSocket y poner el
 * JWT en la URL lo dejaria en los registros del proxy. Aqui se verifica el
 * testimonio como en cualquier ruta (guard global) y se devuelve un ticket
 * opaco, ligado al `sub`, de un solo uso y con caducidad de 30 segundos. No
 * acepta cuerpo: nadie puede pedir un ticket para otro jugador.
 */
@ApiTags('realtime')
@ApiBearerAuth()
@Controller('v1/combat/realtime')
export class RealtimeTicketController {
  constructor(@Inject(ISSUE_REALTIME_TICKET) private readonly issueTicket: IssueRealtimeTicket) {}

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emite un ticket de un solo uso para el WebSocket (ADR-020)' })
  @ApiResponse({ status: 201, type: RealtimeTicketResponse })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  issue(@CurrentIdentity() identity: VerifiedIdentity): {
    readonly ticket: string
    readonly expiresInSeconds: number
  } {
    return this.issueTicket.execute(identity.subject)
  }
}
