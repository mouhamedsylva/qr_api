import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../../auth/rbac/permissions';

export const PERMISSIONS_KEY = 'permissions';
/** Exige toutes les permissions listées dans le restaurant courant. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
