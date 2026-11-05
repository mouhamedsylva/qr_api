import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/** IP et user-agent du client, pour les sessions et le journal d'audit. */
export const ReqMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 255) };
  },
);
