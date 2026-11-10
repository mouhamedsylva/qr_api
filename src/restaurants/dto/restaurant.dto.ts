import { MenuTheme } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsInt,
  IsISO31661Alpha2,
  IsISO4217CurrencyCode,
  IsLatitude,
  IsLocale,
  IsLongitude,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsTimeZone,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SocialLinksDto {
  @IsOptional() @IsUrl() website?: string;
  @IsOptional() @IsUrl() facebook?: string;
  @IsOptional() @IsUrl() instagram?: string;
  @IsOptional() @IsUrl() tiktok?: string;
  @IsOptional() @IsPhoneNumber() whatsapp?: string;
}

export class BrandColorsDto {
  @IsOptional() @IsHexColor() primary?: string;
  @IsOptional() @IsHexColor() secondary?: string;
  @IsOptional() @IsHexColor() accent?: string;
}

/** Création d'un établissement (inscription ou établissement supplémentaire). */
export class CreateRestaurantDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @IsLocale()
  locale?: string;
}

/** Profil d'établissement (RES-01). */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SocialLinksDto)
  socialLinks?: SocialLinksDto;
}

/** Réglages visuels (RES-02). */
export class UpdateBrandingDto {
  /** null : retire le logo. Domaine sans TLD accepté (images servies par l'API en local). */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(500)
  logoUrl?: string | null;

  /** null : retire la bannière. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(500)
  bannerUrl?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => BrandColorsDto)
  brandColors?: BrandColorsDto;

  @IsOptional()
  @IsEnum(MenuTheme)
  menuTheme?: MenuTheme;
}

/** Paramètres régionaux (RES-03). */
export class UpdateRegionalDto {
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @IsOptional()
  @IsLocale()
  locale?: string;

  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  /** Ex. "1 234 FCFA", "€1,234.00" — interprété par les fronts. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  priceFormat?: string;
}

/** Taxes et frais de service (RES-04). Taux en points de base : 1800 = 18 %. */
export class UpdateTaxDto {
  @IsOptional()
  @IsBoolean()
  taxEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  taxRateBp?: number;

  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  serviceFeeBp?: number;
}

export class OpeningHourDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @Matches(HHMM, { message: 'opensAt doit être au format HH:mm' })
  opensAt: string;

  @Matches(HHMM, { message: 'closesAt doit être au format HH:mm' })
  closesAt: string;
}

/** Remplace l'ensemble des horaires hebdomadaires (RES-06). */
export class SetOpeningHoursDto {
  @ValidateNested({ each: true })
  @ArrayMaxSize(28)
  @Type(() => OpeningHourDto)
  hours: OpeningHourDto[];
}

export class CreateClosureDto {
  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
