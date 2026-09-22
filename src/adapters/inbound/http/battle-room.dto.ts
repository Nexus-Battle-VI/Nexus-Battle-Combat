import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator'

/**
 * Cuerpo de `POST /api/v1/combat/rooms` (HU-14.1,
 * `HU-14.1-Contrato-Creacion-Sala.md`, seccion 1).
 *
 * NO LLEVA `playerId` NI `createdBy`: la identidad del creador sale
 * exclusivamente de `identity.subject` (JWT verificado), nunca del cuerpo.
 * Los participantes `HUMAN` que se declaren aqui se resuelven al creador —
 * por eso `ParticipantRequest` tampoco acepta `playerId` del cliente.
 */
/**
 * Apuesta declarada por el cliente (HU-23, RF-23): SOLO el monto. El
 * `holdOperationId` lo resuelve Combat (determinista) y el estado lo decide
 * Wallet; ninguno se acepta del cuerpo.
 *
 * SIN `@Min(1)`: `0` significa "no apostar" (D5) y un negativo o decimal es
 * `INVALID_AMOUNT` (422, regla de negocio), no 400.
 */
export class StakeRequest {
  @ApiProperty({
    minimum: 0,
    description: 'Creditos a apostar. 0 = no apostar (D5); negativo o no entero -> 422.',
  })
  @IsNumber()
  amount!: number
}

export class ParticipantRequest {
  @ApiProperty({ enum: ['HUMAN', 'AI'] })
  @IsIn(['HUMAN', 'AI'])
  kind!: string

  @ApiProperty({
    required: false,
    description: 'Referencia opaca al heroe (HU-16 valida equipamiento).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  heroId?: string

  @ApiProperty({
    required: false,
    type: StakeRequest,
    description:
      'HU-23: apuesta opcional del participante declarado (solo el creador puede ser HUMAN).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StakeRequest)
  stake?: StakeRequest
}

export class TeamConfigRequest {
  /**
   * SIN `@Min`/`@Max` a proposito: el rango 1..3 es una REGLA DE NEGOCIO
   * (`InvalidTeamCapacityError`, 422), no un error de formato (HU-14.1,
   * `HU-14.1-Contrato-Creacion-Sala.md`, seccion "Validaciones", punto 2).
   * Acotarlo aqui con class-validator lo convertiria en 400 y le quitaria al
   * dominio la responsabilidad de decidir esa regla.
   */
  @ApiProperty({
    minimum: 1,
    maximum: 3,
    description: 'Cupos del equipo (RF-14: maximo 3 por equipo, regla de negocio -> 422).',
  })
  @IsInt()
  capacity!: number

  @ApiProperty({
    type: ParticipantRequest,
    isArray: true,
    required: false,
    description: 'Puestos ocupados al crear. Opcional: la sala nace esperando jugadores (CA-01).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ParticipantRequest)
  initialParticipants?: ParticipantRequest[]
}

/**
 * Cuerpo de `POST /v1/combat/rooms/:roomId/join` (HU-15.2, RF-15).
 *
 * `team` es OPCIONAL y solo acepta las etiquetas reales que
 * `BattleRoom.create()` produce (`'A'`/`'B'`): es un enum estructural fijo
 * del sistema, igual que `kind` en `ParticipantRequest`, no una regla de
 * negocio de capacidad. Si se omite, el servidor asigna automaticamente el
 * primer equipo con cupo (DP-1, `HU-15.2-Plan-Implementacion.md`, seccion
 * 1.3). NUNCA acepta `playerId`/`subject` (siempre `identity.subject` del
 * testimonio verificado), `nickname` (bloqueado, DP-2), `heroId` (bloqueado,
 * DP-4), `joinedAt` (siempre `ClockPort`) ni `roomStatus`/`version`
 * (siempre releidos del repositorio).
 */
export class JoinBattleRoomRequest {
  @ApiProperty({
    required: false,
    enum: ['A', 'B'],
    description:
      'Opcional. Si se omite, el servidor asigna automaticamente el primer equipo con cupo.',
  })
  @IsOptional()
  @IsIn(['A', 'B'])
  team?: string

  @ApiProperty({
    required: false,
    type: StakeRequest,
    description:
      'HU-23: apuesta opcional del jugador que se une (D1, individual). Se reserva de forma ' +
      'sincrona antes de persistir la union.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StakeRequest)
  stake?: StakeRequest
}

export class RewardConfigRequest {
  /** SIN `@Min(0)`: `amount < 0` es `InvalidRewardError` (422), no 400. */
  @ApiProperty({ minimum: 0, description: 'Regla de negocio -> 422 si es negativo.' })
  @IsNumber()
  amount!: number
}

export class CreateBattleRoomRequest {
  @ApiProperty({ enum: ['PVP', 'PVE'] })
  @IsIn(['PVP', 'PVE'])
  mode!: string

  @ApiProperty({
    type: TeamConfigRequest,
    isArray: true,
    description: 'Exactamente 2 equipos (RF-14).',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => TeamConfigRequest)
  teamConfigs!: TeamConfigRequest[]

  @ApiProperty({ type: RewardConfigRequest })
  @ValidateNested()
  @Type(() => RewardConfigRequest)
  reward!: RewardConfigRequest
}

class ParticipantStakeResponse {
  @ApiProperty({ description: 'Creditos apostados por el PROPIO jugador.' })
  readonly amount!: number

  @ApiProperty({
    enum: ['PENDING_RESERVE', 'ACTIVE', 'RESERVE_FAILED', 'RELEASED', 'CAPTURED', 'SETTLED_WON'],
  })
  readonly status!: string
}

class ParticipantResponse {
  @ApiProperty({ enum: ['HUMAN', 'AI'] })
  readonly kind!: string

  @ApiProperty({ nullable: true, type: 'string' })
  readonly playerId!: string | null

  @ApiProperty({ nullable: true, type: 'string' })
  readonly heroId!: string | null

  @ApiProperty({
    nullable: true,
    type: 'string',
    description:
      'Snapshot del nombre visible resuelto de Account al unirse (HU-15.2, DP-2). null para ' +
      'AI y para HUMAN incorporados antes de esta version.',
  })
  readonly displayName!: string | null

  @ApiProperty({
    required: false,
    type: ParticipantStakeResponse,
    description:
      'HU-23 (§10): apuesta del PROPIO jugador que pide la sala. Ausente si no aposto o si el ' +
      'participante es un rival (su monto y estado nunca viajan).',
  })
  readonly stake?: ParticipantStakeResponse

  @ApiProperty({ format: 'date-time' })
  readonly joinedAt!: string
}

class TeamResponse {
  @ApiProperty()
  readonly label!: string

  @ApiProperty()
  readonly capacity!: number

  @ApiProperty({ type: ParticipantResponse, isArray: true })
  readonly participants!: readonly ParticipantResponse[]
}

class RewardConfigResponse {
  @ApiProperty()
  readonly amount!: number
}

class StakePoolResponse {
  @ApiProperty({ description: 'Suma de las apuestas ACTIVE de la sala.' })
  readonly total!: number
}

/** Respuesta de creacion, listado y cancelacion (misma forma en los tres). */
export class BattleRoomResponse {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string

  @ApiProperty({ enum: ['PVP', 'PVE'] })
  readonly mode!: string

  @ApiProperty({ enum: ['WAITING_FOR_PLAYERS', 'PREPARING', 'IN_BATTLE', 'CANCELLED'] })
  readonly status!: string

  @ApiProperty({ type: TeamResponse, isArray: true })
  readonly teams!: readonly TeamResponse[]

  @ApiProperty({ type: RewardConfigResponse })
  readonly reward!: RewardConfigResponse

  @ApiProperty({ description: 'Sujeto verificado del JWT del creador.' })
  readonly createdBy!: string

  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string

  @ApiProperty()
  readonly version!: number

  @ApiProperty({ description: 'seq del ultimo evento de batalla (HU-17); 0 sin batalla.' })
  readonly lastSeq!: number

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Batalla en curso (HU-17): battleId, startedAt, turnOrder inmutable, turnsCompleted, round y currentTurn. null hasta IN_BATTLE.',
  })
  readonly battle!: Record<string, unknown> | null

  @ApiProperty({
    type: StakePoolResponse,
    description:
      'HU-23 (§10): resumen agregado de las apuestas ACTIVE de la sala (sin desglosar por rival).',
  })
  readonly stakePool!: StakePoolResponse
}
