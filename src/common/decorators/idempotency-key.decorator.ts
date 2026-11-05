import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * En-tête `Idempotency-Key` obligatoire (CMD-16) : une requête rejouée avec
 * la même clé (double clic, perte réseau) renvoie le résultat initial.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const key = ctx.switchToHttp().getRequest<Request>().get('idempotency-key');
    if (!key || !KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'En-tête Idempotency-Key requis (8 à 100 caractères alphanumériques, - ou _)',
      });
    }
    return key;
  },
);
