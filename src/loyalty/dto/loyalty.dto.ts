import { PartialType } from '@nestjs/swagger';
import { PromotionType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  NotEquals,
  ValidateIf,
} from 'class-validator';

/** Paramètres du programme (CLI-02). Ex. 1 point par tranche de 100 XOF. */
export class UpsertLoyaltyProgramDto {
  @IsBoolean()
  isActive: boolean;

  @IsInt()
  @Min(1)
  pointsPerUnit: number;

  @IsInt()
  @Min(1)
  unitAmount: number;

  /** Points perdus après N jours sans activité ; null = jamais. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  expiryDays?: number | null;
}

/** Récompense échangeable, ex. « Boisson offerte » contre 100 points. */
export class CreateRewardDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @Min(1)
  pointsCost: number;

  @IsEnum(PromotionType)
  type: PromotionType;

  /** PERCENT : points de base ; AMOUNT : montant. */
  @ValidateIf(
    (o: CreateRewardDto) => o.type === 'PERCENT' || o.type === 'AMOUNT',
  )
  @IsInt()
  @Min(1)
  value?: number;

  /** Article offert (FREE_ITEM, BUY_X_GET_Y). */
  @ValidateIf(
    (o: CreateRewardDto) => o.type === 'FREE_ITEM' || o.type === 'BUY_X_GET_Y',
  )
  @IsUUID()
  menuItemId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateRewardDto extends PartialType(CreateRewardDto) {}

/** Correction manuelle d'un solde (geste commercial, erreur). */
export class AdjustPointsDto {
  @IsUUID()
  userId: string;

  @IsInt()
  @NotEquals(0)
  points: number;

  @IsString()
  @Length(3, 255)
  note: string;
}
