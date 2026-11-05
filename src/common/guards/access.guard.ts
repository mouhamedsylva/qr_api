import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { Permission } from '../../auth/rbac/permissions';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SUPER_ADMIN_KEY } from '../decorators/super-admin.decorator';
import type { AppRequest } from '../types/request-context';

/** Vérifie @Roles et @RequirePermissions contre le contexte tenant. */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SUPER_ADMIN_KEY, targets)) {
      const { user } = context.switchToHttp().getRequest<AppRequest>();
      if (!user?.isSuperAdmin) {
        throw new ForbiddenException({
          code: 'SUPER_ADMIN_REQUIRED',
          message: 'Accès réservé à l’administration de la plateforme',
        });
      }
      return true;
    }
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    const permissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      targets,
    );
    if (!roles?.length && !permissions?.length) {
      return true;
    }

    const { tenant } = context.switchToHttp().getRequest<AppRequest>();
    if (!tenant) {
      // Route protégée par rôle/permission sans :restaurantId : refus par défaut.
      throw new ForbiddenException();
    }
    if (tenant.role === null) {
      return true; // super-admin
    }
    if (roles?.length && !roles.includes(tenant.role)) {
      throw new ForbiddenException({
        code: 'ROLE_REQUIRED',
        message: 'Rôle insuffisant pour cette action',
      });
    }
    const missing = (permissions ?? []).filter(
      (p) => !tenant.permissions.has(p),
    );
    if (missing.length) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Permission refusée',
        details: { missing },
      });
    }
    return true;
  }
}
