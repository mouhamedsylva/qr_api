import {
  OrderMode,
  OrderSource,
  OrderStatus,
  PaymentStatus,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const MAX_LINES_PER_ORDER = 100;

/** Ligne du panier (CMD-05). */
export class OrderLineDto {
  @IsUUID()
  menuItemId: string;

  @IsInt()
  @Min(1)
  @Max(50)
  quantity: number;

  @IsOptional()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  optionIds?: string[];

  /** Ex. « sans oignon ». */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  notes?: string;
}

class OrderBaseDto {
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES_PER_ORDER)
  @Type(() => OrderLineDto)
  items: OrderLineDto[];

  @IsOptional()
  @IsString()
  @Length(1, 100)
  customerName?: string;

  @IsOptional()
  @IsPhoneNumber()
  customerPhone?: string;

  /** Instructions générales. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  tipAmount?: number;

  /** Code promo ou bon de fidélité (CMD-13, CLI-02). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  promoCode?: string;
}

/**
 * Commande passée par le client depuis la PWA.
 * Sur place : `qrToken` (QR de la table) obligatoire.
 * À emporter : QR comptoir, ou `restaurantSlug`.
 */
export class CreatePublicOrderDto extends OrderBaseDto {
  @IsEnum(OrderMode)
  mode: OrderMode;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  qrToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  restaurantSlug?: string;
}

/** Saisie manuelle par le staff (CMD-12). */
export class CreateStaffOrderDto extends OrderBaseDto {
  @IsEnum(OrderMode)
  mode: OrderMode;

  @IsOptional()
  @IsUUID()
  tableId?: string;
}

/** Commande additionnelle sur une commande ouverte (CMD-06). */
export class AddItemsDto {
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES_PER_ORDER)
  @Type(() => OrderLineDto)
  items: OrderLineDto[];
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  /** Obligatoire pour une annulation ou un refus (CMD-08). */
  @IsOptional()
  @IsString()
  @Length(3, 255)
  reason?: string;
}

export class CustomerCancelDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

const toArray = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').filter(Boolean) : value;

/** Historique et filtres (CMD-03). */
export class ListOrdersQueryDto extends PaginationQueryDto {
  /** Un ou plusieurs statuts séparés par des virgules. */
  @IsOptional()
  @Transform(toArray)
  @IsEnum(OrderStatus, { each: true })
  status?: OrderStatus[];

  @IsOptional()
  @IsEnum(OrderMode)
  mode?: OrderMode;

  @IsOptional()
  @IsEnum(OrderSource)
  source?: OrderSource;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @IsUUID()
  tableId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minTotal?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxTotal?: number;

  /** Numéro de commande ou nom / téléphone du client. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
