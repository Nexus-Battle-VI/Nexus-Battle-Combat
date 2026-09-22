import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class RewardProductResponse {
  @ApiProperty() productId!: string
  @ApiProperty() sku!: string
  @ApiProperty() name!: string
}

export class RewardStatusResponse {
  @ApiPropertyOptional({ nullable: true }) creditsEarned!: number | null
  @ApiPropertyOptional({ nullable: true }) balance!: number | null
  @ApiPropertyOptional({ nullable: true }) victoryProgress!: number | null
  @ApiPropertyOptional({ nullable: true }) weeklyChestCount!: number | null
  @ApiPropertyOptional({ nullable: true }) chestEarned!: boolean | null
  @ApiProperty({ enum: ['NONE', 'PENDING', 'CONFIRMED', 'FAILED'] }) rewardDelivery!: string
  @ApiPropertyOptional({ type: RewardProductResponse, nullable: true })
  reward!: RewardProductResponse | null
}
