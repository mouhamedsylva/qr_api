import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BillingService } from '../../billing/billing.service';
import type { Feature } from '../../billing/plans.defaults';
import { PrismaService } from '../../prisma/prisma.service';
import { FEATURE_KEY } from '../decorators/feature.decorator';
import type { AppRequest } from '../types/request-context';

/**
 * Feature flags par forfait (ADM-04) : vérifie que le forfait effectif du
 * propriétaire de l'établissement inclut la fonctionnalité demandée.
 * S'exécute après TenantGuard (le tenant est déjà résolu).
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<Feature | undefined>(
      FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;

    const { tenant, user } = context.switchToHttp().getRequest<AppRequest>();
    if (user?.isSuperAdmin) return true;
    if (!tenant) throw new ForbiddenException();

    const { ownerId } = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: tenant.restaurantId },
      select: { ownerId: true },
    });
    if (!(await this.billing.hasFeature(ownerId, feature))) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'Cette fonctionnalité n’est pas incluse dans votre forfait',
        details: { feature },
      });
    }
    return true;
  }
}
