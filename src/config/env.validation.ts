import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Booléen d'environnement : « true » / « 1 » (insensible à la casse).
 * La conversion implicite ferait de la chaîne « false » un true.
 */
function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  return ['true', '1'].includes(value.trim().toLowerCase());
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET: string;

  @IsString()
  JWT_ACCESS_TTL: string = '15m';

  @IsInt()
  @Min(1)
  JWT_REFRESH_TTL_DAYS: number = 30;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsString()
  @MinLength(32)
  QR_SIGNING_SECRET: string;

  @IsUrl({ require_tld: false })
  CLIENT_APP_URL: string;

  /** Back-office (liens d'invitation) ; par défaut CLIENT_APP_URL. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  BACKOFFICE_URL?: string;

  @IsString()
  LOG_LEVEL: string = 'info';

  @IsOptional()
  @IsString()
  STRIPE_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  STRIPE_WEBHOOK_SECRET?: string;

  @IsInt()
  @Min(0)
  @Max(5000)
  PLATFORM_COMMISSION_BP: number = 0;

  /** Ex. smtp://user:pass@smtp.exemple.com:587 ; vide = emails écrits dans les logs. */
  @IsOptional()
  @IsString()
  SMTP_URL?: string;

  /** Facultatif : quotas et temps réel partagés entre instances. */
  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsString()
  SMTP_FROM: string = 'QR-Order <no-reply@qr-order.local>';

  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    parseBoolean(obj.JOBS_ENABLED, true),
  )
  @IsBoolean()
  JOBS_ENABLED: boolean = true;

  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    parseBoolean(obj.PAYMENTS_SANDBOX_ENABLED, false),
  )
  @IsBoolean()
  PAYMENTS_SANDBOX_ENABLED: boolean = false;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Configuration invalide :\n${details}`);
  }
  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.PAYMENTS_SANDBOX_ENABLED
  ) {
    throw new Error(
      'Configuration invalide : PAYMENTS_SANDBOX_ENABLED est interdit en production',
    );
  }
  return validated;
}
