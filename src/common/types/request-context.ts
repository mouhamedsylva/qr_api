import type { Role } from '@prisma/client';
import type { Request } from 'express';
import type { Permission } from '../../auth/rbac/permissions';

export interface AuthUser {
  id: string;
  isSuperAdmin: boolean;
}

export interface TenantContext {
  restaurantId: string;
  role: Role | null; // null = accès super-admin sans membership
  permissions: Set<Permission>;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  tenant?: TenantContext;
}

/** Auteur d'une action, pour le journal d'audit. */
export interface Actor {
  id: string;
  ip?: string;
  userAgent?: string;
}
