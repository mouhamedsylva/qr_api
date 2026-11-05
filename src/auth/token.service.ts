import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID } from 'crypto';
import { randomToken } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestMeta } from '../common/decorators/request-meta.decorator';
import type { AccessTokenPayload } from './strategies/jwt.strategy';

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Access token JWT court + refresh token opaque rotatif (AUT-04).
 * Chaque refresh produit un nouveau jeton de la même « famille » ; la
 * réutilisation d'un jeton déjà consommé révoque toute la famille
 * (signe de vol de jeton).
 */
@Injectable()
export class TokenService {
  private readonly refreshSecret: string;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.refreshTtlMs =
      config.getOrThrow<number>('JWT_REFRESH_TTL_DAYS') * 24 * 60 * 60 * 1000;
  }

  hash(token: string): string {
    return createHmac('sha256', this.refreshSecret).update(token).digest('hex');
  }

  async issue(
    user: { id: string; isSuperAdmin: boolean },
    meta: RequestMeta,
  ): Promise<TokenPair> {
    const { pair } = await this.createPair(user, meta, randomUUID());
    return pair;
  }

  private async createPair(
    user: { id: string; isSuperAdmin: boolean },
    meta: RequestMeta,
    familyId: string,
  ): Promise<{ pair: TokenPair; refreshTokenId: string }> {
    const payload: AccessTokenPayload = { sub: user.id, sa: user.isSuperAdmin };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    const record = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hash(refreshToken),
        familyId,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    return {
      pair: {
        tokenType: 'Bearer',
        accessToken,
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
      },
      refreshTokenId: record.id,
    };
  }

  async rotate(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(refreshToken) },
      include: { user: true },
    });
    if (!current) {
      throw invalidToken();
    }
    if (current.revokedAt) {
      await this.revokeFamily(current.familyId);
      throw new UnauthorizedException({
        code: 'TOKEN_REUSED',
        message: 'Session invalidée, veuillez vous reconnecter',
      });
    }
    if (current.expiresAt <= new Date()) {
      throw invalidToken();
    }
    const { user } = current;
    if (user.deletedAt || user.status !== 'ACTIVE') {
      await this.revokeFamily(current.familyId);
      throw invalidToken();
    }

    // Consommation atomique : deux refresh concurrents avec le même jeton
    // ne peuvent pas réussir tous les deux.
    const consumed = await this.prisma.refreshToken.updateMany({
      where: { id: current.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (consumed.count === 0) {
      await this.revokeFamily(current.familyId);
      throw new UnauthorizedException({
        code: 'TOKEN_REUSED',
        message: 'Session invalidée, veuillez vous reconnecter',
      });
    }

    const { pair, refreshTokenId } = await this.createPair(
      user,
      meta,
      current.familyId,
    );
    await this.prisma.refreshToken.update({
      where: { id: current.id },
      data: { replacedById: refreshTokenId },
    });
    return pair;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

function invalidToken() {
  return new UnauthorizedException({
    code: 'INVALID_REFRESH_TOKEN',
    message: 'Jeton de rafraîchissement invalide ou expiré',
  });
}
