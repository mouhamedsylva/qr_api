import { OmitType, PartialType } from '@nestjs/swagger';
import { TableKind, TableStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateZoneDto {
  @IsString()
  @Length(1, 100)
  name: string;
}

export class UpdateZoneDto extends PartialType(CreateZoneDto) {}

export class CreateTableDto {
  @IsString()
  @Length(1, 50)
  label: string;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number;

  /** COUNTER : QR global pour la vente à emporter / au comptoir (TAB-10). */
  @IsOptional()
  @IsEnum(TableKind)
  kind?: TableKind;
}

export class UpdateTableDto extends PartialType(
  OmitType(CreateTableDto, ['zoneId']),
) {
  /** null pour retirer la table de sa zone. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  zoneId?: string | null;
}

/** Création par lot (TAB-01) : prefix + numéros de `from` à `to`, ex. T1…T20. */
export class BulkCreateTablesDto {
  @IsOptional()
  @IsString()
  @Matches(/^[\p{L}\p{N} _-]{0,20}$/u, {
    message: 'Préfixe invalide (20 caractères max.)',
  })
  prefix: string = '';

  @IsInt()
  @Min(0)
  @Max(9999)
  from: number;

  @IsInt()
  @Min(0)
  @Max(9999)
  to: number;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number;
}

export class UpdateTableStatusDto {
  @IsEnum(TableStatus)
  status: TableStatus;
}

export class ListTablesQueryDto {
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsEnum(TableStatus)
  status?: TableStatus;
}

export class QrImageQueryDto {
  @IsOptional()
  @IsIn(['png', 'svg'])
  format: 'png' | 'svg' = 'png';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(128)
  @Max(2048)
  size: number = 512;
}
