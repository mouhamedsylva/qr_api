import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /**
   * Routes publiques : authentification facultative. Un jeton valide
   * identifie le client (commande rattachée à son compte, CLI-01) ; un jeton
   * absent ou invalide n'empêche pas l'accès anonyme.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isPublic) {
      return (await super.canActivate(context)) as boolean;
    }
    const req = context.switchToHttp().getRequest<Request>();
    if (req.get('authorization')?.startsWith('Bearer ')) {
      try {
        await super.canActivate(context);
      } catch {
        // jeton invalide sur une route publique : accès anonyme
      }
    }
    return true;
  }

  handleRequest<TUser>(
    err: unknown,
    user: TUser,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return user || (undefined as TUser);
    return super.handleRequest(err, user, info, context);
  }
}
