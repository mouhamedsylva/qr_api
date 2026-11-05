import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  PERMISSIONS,
  PermissionOverrides,
  resolvePermissions,
} from '../../auth/rbac/permissions';
import { PrismaService } from '../../prisma/prisma.service';
import type { AppRequest } from '../types/request-context';

/**
 * Résout le tenant à partir du paramètre de route `:restaurantId`.
 * Le restaurantId n'est jamais lu depuis le corps de la requête : l'isolation
 * multi-tenant est imposée côté serveur. Un non-membre reçoit 404 (pas de
 * divulgation de l'existence du restaurant).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const param = req.params?.restaurantId;
    const restaurantId = typeof param === 'string' ? param : undefined;
    if (!restaurantId || !req.user) {
      return true;
    }
    if (!isUUID(restaurantId)) {
      throw new NotFoundException('Restaurant introuvable');
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!restaurant) {
      throw new NotFoundException('Restaurant introuvable');
    }

    if (req.user.isSuperAdmin) {
      req.tenant = {
        restaurantId,
        role: null,
        permissions: new Set(PERMISSIONS),
      };
      return true;
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId: req.user.id, restaurantId, deletedAt: null },
      select: { role: true, permissions: true },
    });
    if (!membership) {
      throw new NotFoundException('Restaurant introuvable');
    }
    if (restaurant.status === 'BANNED') {
      throw new ForbiddenException({
        code: 'RESTAURANT_BANNED',
        message: 'Cet établissement a été banni de la plateforme',
      });
    }

    req.tenant = {
      restaurantId,
      role: membership.role,
      permissions: resolvePermissions(
        membership.role,
        membership.permissions as PermissionOverrides | null,
      ),
    };
    return true;
  }
}
