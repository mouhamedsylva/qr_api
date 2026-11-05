import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';
/** Restreint la route à certains rôles dans le restaurant courant. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
