import { Role } from '@prisma/client';

/** Catalogue des permissions fonctionnelles (toggles AUT-03). */
export const PERMISSIONS = [
  'restaurant.view',
  'restaurant.update',
  'restaurant.settings',
  'restaurant.delete',
  'dashboard.view',
  'menu.view',
  'menu.manage',
  'menu.availability',
  'tables.view',
  'tables.manage',
  'tables.status',
  'orders.view',
  'orders.manage',
  'orders.cancel',
  'orders.refund',
  'payments.collect',
  'team.view',
  'team.manage',
  'reports.view',
  'marketing.manage',
  'reviews.manage',
  'integrations.manage',
  'billing.manage',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  OWNER: ALL,
  MANAGER: ALL.filter(
    (p) => !['restaurant.delete', 'billing.manage'].includes(p),
  ),
  STAFF: [
    'restaurant.view',
    'menu.view',
    'menu.availability',
    'tables.view',
    'tables.status',
    'orders.view',
    'orders.manage',
    'payments.collect',
  ],
  CUSTOMER: [],
};

/** Permissions jamais retirables pour un OWNER (évite de s'auto-verrouiller). */
const OWNER_LOCKED: Permission[] = ['restaurant.view', 'team.manage'];

export interface PermissionOverrides {
  grant?: string[];
  deny?: string[];
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Permissions effectives = défauts du rôle ∪ grant − deny. */
export function resolvePermissions(
  role: Role,
  overrides?: PermissionOverrides | null,
): Set<Permission> {
  const result = new Set<Permission>(ROLE_DEFAULT_PERMISSIONS[role]);
  for (const p of overrides?.grant ?? []) {
    // Un STAFF ne peut pas recevoir de permissions d'administration critiques.
    if (isPermission(p) && !(role === 'STAFF' && p === 'billing.manage')) {
      result.add(p);
    }
  }
  for (const p of overrides?.deny ?? []) {
    if (isPermission(p) && !(role === 'OWNER' && OWNER_LOCKED.includes(p))) {
      result.delete(p);
    }
  }
  return result;
}
