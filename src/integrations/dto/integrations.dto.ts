import {
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from 'class-validator';
import { API_SCOPES, WEBHOOK_EVENTS } from '../integrations.rules';

export class CreateApiKeyDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(API_SCOPES, { each: true })
  scopes: string[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class CreateWebhookDto {
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  @MaxLength(500)
  url: string;

  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events: string[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  /** Réactiver un point désactivé après trop d'échecs remet son compteur à zéro. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PeriodQueryDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;
}
