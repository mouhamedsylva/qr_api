import { OmitType, PartialType } from '@nestjs/swagger';
import { PromotionType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Code promo (CMD-13). */
export class CreatePromotionDto {
  @Transform(upper)
  @Matches(/^[A-Z0-9_-]{3,40}$/, {
    message: 'Code de 3 à 40 caractères (lettres, chiffres, - ou _)',
  })
  code: string;

  @IsString()
  @Length(2, 120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsEnum(PromotionType)
  type: PromotionType;

  /** PERCENT : points de base (1000 = 10 %) ; AMOUNT : montant. */
  @ValidateIf(
    (o: CreatePromotionDto) => o.type === 'PERCENT' || o.type === 'AMOUNT',
  )
  @IsInt()
  @Min(1)
  value?: number;

  @ValidateIf((o: CreatePromotionDto) => o.type === 'BUY_X_GET_Y')
  @IsInt()
  @Min(1)
  buyQuantity?: number;

  @ValidateIf((o: CreatePromotionDto) => o.type === 'BUY_X_GET_Y')
  @IsInt()
  @Min(1)
  freeQuantity?: number;

  @ValidateIf(
    (o: CreatePromotionDto) =>
      o.type === 'BUY_X_GET_Y' || o.type === 'FREE_ITEM',
  )
  @IsUUID()
  menuItemId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSubtotal?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxDiscount?: number;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  perCustomerLimit?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Le code identifie la promotion : il n'est pas modifiable. */
export class UpdatePromotionDto extends PartialType(
  OmitType(CreatePromotionDto, ['code'] as const),
) {}
