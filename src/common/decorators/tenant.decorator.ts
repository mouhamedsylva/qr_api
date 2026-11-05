import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest, TenantContext } from '../types/request-context';

/** Contexte tenant résolu par TenantGuard (restaurantId + rôle + permissions). */
export const Tenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext | undefined =>
    ctx.switchToHttp().getRequest<AppRequest>().tenant,
);
