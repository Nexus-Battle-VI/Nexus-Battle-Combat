import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsInt, IsString, ValidateNested } from 'class-validator'

/**
 * Cuerpo de `POST /api/internal/v1/combat/experience-rolls` (HU-09, Task HU-09.2;
 * `hu-09-experience-reward-v1` §5.2).
 *
 * SOLO DECLARA TIPOS, NO REGLAS. Aqui no hay `@ArrayMinSize(1)` ni
 * `@Equals(1)`: el lote vacio y una `schemaVersion` distinta de la vigente son
 * rechazos de ESQUEMA DEL CONTRATO y su `400 SCHEMA_INVALID` lo produce el caso
 * de uso, que es quien puede devolver el `code` del contrato. Una regla puesta
 * aqui saldria del `ValidationPipe` global con el cuerpo estandar de Nest, sin
 * `code`, y Missions no podria distinguirla. El pipe sigue haciendo su trabajo:
 * un tipo equivocado (`defeats` como cadena, `schemaVersion` como texto) ni
 * siquiera llega al caso de uso.
 */
export class ExperienceRollDefeatRequest {
  @ApiProperty({ description: 'Indice del encuentro en la mision (el `encounter` del combatLog).' })
  @IsString()
  encounterId!: string

  @ApiProperty({ description: 'Instancia concreta del enemigo: `<enemyRef>#<n>`.' })
  @IsString()
  enemyInstanceId!: string

  @ApiProperty({
    description: 'Arquetipo del enemigo. Viaja para traza; NO identifica la derrota.',
  })
  @IsString()
  rivalRef!: string
}

export class ExperienceRollsRequest {
  @ApiProperty({ enum: [1], description: 'Version del esquema del contrato interno.' })
  @IsInt()
  schemaVersion!: number

  @ApiProperty({
    description: '`mission:{enrollmentId}:xp-rolls`. Determinista; lo calcula Missions.',
  })
  @IsString()
  operationId!: string

  @ApiProperty() @IsString() enrollmentId!: string
  @ApiProperty() @IsString() simulationId!: string
  @ApiProperty() @IsString() heroId!: string

  @ApiProperty({
    type: [ExperienceRollDefeatRequest],
    description:
      'Una entrada por NPC derrotado. Vacio -> 400 SCHEMA_INVALID (lo decide el caso de uso).',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExperienceRollDefeatRequest)
  defeats!: ExperienceRollDefeatRequest[]
}

/**
 * Respuesta de §5.2, campo a campo. Los cuatro de cada tirada son EXACTAMENTE
 * los del contrato: `rivalRef` no viaja porque el contrato no lo declara, y
 * `persistedAt` sale como fecha ISO-8601 con milisegundos, igual que en el
 * ejemplo.
 */
export class ExperienceRollResponse {
  @ApiProperty() encounterId!: string
  @ApiProperty() enemyInstanceId!: string
  @ApiProperty({ minimum: 1, maximum: 8, description: 'Cara del 1d8.' }) roll!: number
  @ApiProperty({ description: 'Momento en que se persistio el lote (ISO-8601).' })
  persistedAt!: string
}

export class ExperienceRollsResponse {
  @ApiProperty({ enum: [1] }) schemaVersion!: number
  @ApiProperty() operationId!: string
  @ApiProperty({ description: '`false` en un replay idempotente del mismo lote.' })
  applied!: boolean
  @ApiProperty({ type: [ExperienceRollResponse], description: 'En el orden de la peticion.' })
  rolls!: ExperienceRollResponse[]
}
