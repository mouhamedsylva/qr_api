import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import type { Request, Response } from 'express';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ApiClient, ApiKeysService } from './api-keys.service';
import type { ApiScope } from './integrations.rules';

/** Quota par clé (INT-01). */
export const API_RATE_LIMIT = 120;
const WINDOW_MS = 60_000;

const SCOPES_KEY = 'apiScopes';
/** Droits requis pour une route de l'API publique. */
export const ApiScopes = (...scopes: ApiScope[]) =>
  SetMetadata(SCOPES_KEY, scopes);

type ApiRequest = Request & { apiClient?: ApiClient };

export const CurrentApiClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiClient =>
    ctx.switchToHttp().getRequest<ApiRequest>().apiClient!,
);

/**
 * Authentification de l'API publique par en-tête `X-Api-Key`, droits par clé
 * et quota par fenêtre d'une minute. Le compteur est dans Redis s'il est
 * configuré (partagé entre instances), en mémoire sinon.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  /** Compte la requête dans la fenêtre courante (alignée sur la minute). */
  private async hit(keyId: string, now: number) {
    const windowStart = now - (now % WINDOW_MS);
    if (this.redis) {
      const key = `ratelimit:apikey:${keyId}:${windowStart}`;
      const [[, count]] = (await this.redis
        .multi()
        .incr(key)
        .pexpire(key, WINDOW_MS * 2)
        .exec()) as [[Error | null, number]];
      return { count, start: windowStart };
    }
    const window = this.windows.get(keyId);
    const current =
      window && window.start === windowStart
        ? window
        : { start: windowStart, count: 0 };
    current.count++;
    this.windows.set(keyId, current);
    return current;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<Response>();

    const client = await this.apiKeys.authenticate(req.get('x-api-key'));
    if (!client) {
      throw new UnauthorizedException({
        code: 'INVALID_API_KEY',
        message: 'Clé d’API absente, invalide, révoquée ou expirée',
      });
    }

    const now = Date.now();
    const current = await this.hit(client.keyId, now);
    res.setHeader('X-RateLimit-Limit', API_RATE_LIMIT);
    res.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, API_RATE_LIMIT - current.count),
    );
    if (current.count > API_RATE_LIMIT) {
      res.setHeader(
        'Retry-After',
        Math.ceil((current.start + WINDOW_MS - now) / 1000),
      );
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Quota de requêtes dépassé' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const required = this.reflector.getAllAndOverride<ApiScope[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const missing = (required ?? []).filter((s) => !client.scopes.includes(s));
    if (missing.length) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_SCOPE',
        message: 'Cette clé n’a pas les droits nécessaires',
        details: { missing },
      });
    }
    req.apiClient = client;
    return true;
  }
}
