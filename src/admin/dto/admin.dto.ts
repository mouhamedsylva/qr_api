import { OmitType, PartialType } from '@nestjs/swagger';
import {
  BillingCycle,
  RestaurantStatus,
  SubscriptionStatus,
  UserStatus,
} from '@prisma/client';
import {
  ArrayUnique,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
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
import { FEATURES } from '../../billing/plans.defaults';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class ListRestaurantsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(RestaurantStatus)
  status?: RestaurantStatus;
}

/** Modération (ADM-02) : motif obligatoire. */
export class ModerateRestaurantDto {
  @IsEnum(RestaurantStatus)
  status: RestaurantStatus;

  @IsString()
  @Length(3, 255)
  reason: string;
}

export class ModerateUserDto {
  @IsEnum(UserStatus)
  status: UserStatus;

  @IsString()
  @Length(3, 255)
  reason: string;
}

/** Gestion des forfaits (ADM-04). Quotas null = illimité. */
export class CreatePlanDto {
  @Matches(/^[A-Z][A-Z0-9_]{1,29}$/, {
    message: 'Code en majuscules (ex. PRO_PLUS)',
  })
  code: string;

  @IsString()
  @Length(2, 60)
  name: string;

  @IsInt()
  @Min(0)
  priceMonthly: number;

  @IsInt()
  @Min(0)
  priceYearly: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxRestaurants?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxTables?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  maxMembers?: number | null;

  @ArrayUnique()
  @IsIn(FEATURES, { each: true })
  features: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Le code d'un forfait est immuable. */
export class UpdatePlanDto extends PartialType(
  OmitType(CreatePlanDto, ['code'] as const),
) {}

/** Activation / renouvellement / suspension d'un abonnement (PAY-03, PAY-12). */
export class UpdateSubscriptionDto {
  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;

  @IsOptional()
  @IsDateString()
  currentPeriodEnd?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  graceUntil?: string | null;

  /** Autorise un forfait inférieur à l'utilisation actuelle. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  /** Préfixe d'action, ex. « payments. » */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
