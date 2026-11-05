import { PartialType } from '@nestjs/swagger';
import { KitchenItemStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

/** Valeur spéciale : lignes sans poste attribué. */
export const UNASSIGNED = 'none';

export class CreateStationDto {
  @IsString()
  @Length(1, 60)
  name: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateStationDto extends PartialType(CreateStationDto) {}

export class TicketsQueryDto {
  /** Identifiant d'un poste, ou « none » pour les lignes non routées. */
  @IsOptional()
  @ValidateIf((_, v) => v !== UNASSIGNED)
  @IsUUID()
  stationId?: string;

  /** Inclure les tickets dont toutes les lignes du poste sont prêtes. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeReady?: boolean;
}

export class UpdateItemStatusDto {
  @IsEnum(KitchenItemStatus)
  status: KitchenItemStatus;
}

/** « Bump » : toutes les lignes d'un poste (ou de la commande) passent prêtes. */
export class BumpDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== UNASSIGNED)
  @IsUUID()
  stationId?: string;

  @IsOptional()
  @IsIn([KitchenItemStatus.IN_PROGRESS, KitchenItemStatus.READY])
  status: KitchenItemStatus = KitchenItemStatus.READY;
}

export class RushDto {
  @IsBoolean()
  isRush: boolean;
}
