import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Actor, AppRequest, AuthUser } from '../types/request-context';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AppRequest>().user,
);

/** Utilisateur courant + IP + user-agent, pour journaliser une action. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    return {
      id: req.user!.id,
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 255),
    };
  },
);
