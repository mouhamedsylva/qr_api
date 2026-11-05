import { Role, StaffProfile } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  Equals,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PERMISSIONS } from '../../auth/rbac/permissions';

/** Rôles attribuables par invitation ou promotion (EQP-02). */
export const ASSIGNABLE_ROLES: Role[] = ['MANAGER', 'STAFF'];

export class PermissionOverridesDto {
  @IsOptional()
  @ArrayUnique()
  @IsIn(PERMISSIONS, { each: true })
  grant?: string[];

  @IsOptional()
  @ArrayUnique()
  @IsIn(PERMISSIONS, { each: true })
  deny?: string[];
}

/** Invitation par email, SMS ou lien partageable (EQP-01). */
export class InviteMemberDto {
  @ValidateIf((o: InviteMemberDto) => !o.phone || o.email !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email?: string;

  @ValidateIf((o: InviteMemberDto) => !o.email || o.phone !== undefined)
  @IsPhoneNumber()
  phone?: string;

  @IsIn(ASSIGNABLE_ROLES)
  role: Role;

  @IsOptional()
  @IsEnum(StaffProfile)
  staffProfile?: StaffProfile;

  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionOverridesDto)
  permissions?: PermissionOverridesDto;
}

/** Promotion / rétrogradation et toggles de permissions (EQP-02, AUT-03). */
export class UpdateMemberDto {
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: Role;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEnum(StaffProfile)
  staffProfile?: StaffProfile | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionOverridesDto)
  permissions?: PermissionOverridesDto;
}

/** Acceptation d'une invitation par une personne sans compte. */
export class AcceptInvitationDto {
  @IsString()
  @Length(1, 100)
  firstName: string;

  @IsString()
  @Length(1, 100)
  lastName: string;

  /** Obligatoire si l'invitation a été envoyée par SMS. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email?: string;

  @Matches(/^(?=.*[A-Za-z])(?=.*\d).{8,128}$/, {
    message:
      'Le mot de passe doit contenir 8 caractères minimum, dont au moins une lettre et un chiffre',
  })
  password: string;

  @Equals(true, { message: 'Les conditions générales doivent être acceptées' })
  acceptTerms: boolean;
}
