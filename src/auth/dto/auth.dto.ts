import { OtpChannel } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** 8 caractères minimum, au moins une lettre et un chiffre. */
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
const PASSWORD_MESSAGE =
  'Le mot de passe doit contenir 8 caractères minimum, dont au moins une lettre et un chiffre';

export class RegisterDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(191)
  email: string;

  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password: string;

  @IsString()
  @Length(1, 100)
  firstName: string;

  @IsString()
  @Length(1, 100)
  lastName: string;

  /** Format international E.164, ex. +221771234567 */
  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @IsString()
  @Length(2, 150)
  restaurantName: string;

  /** Acceptation des CGU et de la politique de confidentialité (CON-02). */
  @Equals(true, { message: 'Les conditions générales doivent être acceptées' })
  acceptTerms: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;
}

export class LoginDto {
  @Transform(normalizeEmail)
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(20)
  refreshToken: string;
}

export class SendOtpDto {
  @IsEnum(OtpChannel)
  channel: OtpChannel;
}

export class VerifyOtpDto {
  @IsEnum(OtpChannel)
  channel: OtpChannel;

  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  code: string;
}

export class ForgotPasswordDto {
  @Transform(normalizeEmail)
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @Transform(normalizeEmail)
  @IsEmail()
  email: string;

  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  code: string;

  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword: string;
}
