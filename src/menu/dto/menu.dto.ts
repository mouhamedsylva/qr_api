import { OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  MaxLength,
  Min,
  Max,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const ALLERGENS = [
  'GLUTEN',
  'PEANUTS',
  'TREE_NUTS',
  'MILK',
  'EGGS',
  'FISH',
  'SHELLFISH',
  'MOLLUSCS',
  'SOY',
  'SESAME',
  'MUSTARD',
  'CELERY',
  'SULPHITES',
  'LUPIN',
] as const;

export const DIETARY_TAGS = [
  'VEGETARIAN',
  'VEGAN',
  'HALAL',
  'GLUTEN_FREE',
  'SPICY',
] as const;

// ───────────── Catégories (MEN-01) ─────────────

export class CreateCategoryDto {
  @IsString()
  @Length(1, 120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  imageUrl?: string;

  /** Catégorie parente (un seul niveau de sous-catégorie). */
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Poste de préparation par défaut des articles (KDS-02). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  stationId?: string | null;
}

export class UpdateCategoryDto extends PartialType(
  OmitType(CreateCategoryDto, ['parentId']),
) {
  /** null pour remonter une sous-catégorie au premier niveau. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
}

// ───────────── Options et modificateurs (MEN-03) ─────────────

export class OptionDto {
  @IsString()
  @Length(1, 120)
  name: string;

  /** Supplément en plus petite unité monétaire (peut être 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  priceDelta?: number;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

export class OptionGroupDto {
  @IsString()
  @Length(1, 120)
  name: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelect?: number;

  @ValidateNested({ each: true })
  @ArrayMaxSize(50)
  @Type(() => OptionDto)
  options: OptionDto[];
}

// ───────────── Articles (MEN-02, MEN-06) ─────────────

export class CreateMenuItemDto {
  @IsUUID()
  categoryId: string;

  @IsString()
  @Length(1, 150)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  priceAmount: number;

  /** Coût de revient (interne), pour le calcul de marge (ANA-02). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  costAmount?: number | null;

  @IsOptional()
  @ArrayMaxSize(10)
  // Sans exigence de domaine de premier niveau : photos servies par l'API en local (http://localhost:3000/uploads/…).
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] }, { each: true })
  images?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  prepTimeMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Poste de préparation (KDS-02) ; prioritaire sur celui de la catégorie. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  stationId?: string | null;

  @IsOptional()
  @ArrayUnique()
  @IsIn(ALLERGENS, { each: true })
  allergens?: string[];

  @IsOptional()
  @ArrayUnique()
  @IsIn(DIETARY_TAGS, { each: true })
  dietaryTags?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  calories?: number;

  /** Remplace l'ensemble des groupes d'options quand fourni. */
  @IsOptional()
  @ValidateNested({ each: true })
  @ArrayMaxSize(20)
  @Type(() => OptionGroupDto)
  optionGroups?: OptionGroupDto[];
}

export class UpdateMenuItemDto extends PartialType(CreateMenuItemDto) {}

/** Disponibilité instantanée (MEN-04), accessible au staff. */
export class UpdateAvailabilityDto {
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  /** Date de remise automatique à disponible, ou null. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  availableAgainAt?: string | null;

  /** Stock limité, ou null pour illimité. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  stockQuantity?: number | null;
}

export class ListMenuItemsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;
}

export const BULK_ITEM_ACTIONS = ['hide', 'show', 'delete'] as const;
export type BulkItemAction = (typeof BULK_ITEM_ACTIONS)[number];

/** Action groupée sur une sélection d'articles : masquer, afficher ou supprimer. */
export class BulkItemsDto {
  @IsIn(BULK_ITEM_ACTIONS)
  action: BulkItemAction;

  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids: string[];
}

export class ReorderItemsDto {
  @IsUUID()
  categoryId: string;

  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids: string[];
}
