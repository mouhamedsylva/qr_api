import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import type { Actor } from '../common/types/request-context';
import { randomToken } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Droits des personnes (CON-01, CON-03) — loi sénégalaise n° 2008-12 et RGPD.
 * Les commandes, paiements et journaux sont conservés pour les obligations
 * légales (CON-07) : la suppression d'un compte se fait par anonymisation.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /** Export des données personnelles de l'utilisateur (droit d'accès / portabilité). */
  async exportUserData(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        status: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        termsAcceptedAt: true,
        termsVersion: true,
        createdAt: true,
        updatedAt: true,
        memberships: {
          select: {
            role: true,
            staffProfile: true,
            createdAt: true,
            deletedAt: true,
            restaurant: { select: { id: true, name: true } },
          },
        },
        ownedRestaurants: {
          select: { id: true, name: true, slug: true, createdAt: true },
        },
        subscription: {
          select: {
            status: true,
            billingCycle: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            plan: { select: { code: true, name: true } },
          },
        },
        refreshTokens: {
          select: {
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            ip: true,
            userAgent: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    const activity = await this.prisma.auditLog.findMany({
      where: { actorId: userId },
      select: {
        action: true,
        entity: true,
        restaurantId: true,
        ip: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const { refreshTokens, ...profile } = user;
    return {
      exportedAt: new Date(),
      profile,
      sessions: refreshTokens,
      activity,
    };
  }

  /**
   * Suppression du compte (droit à l'effacement). Refusée tant que la personne
   * possède des établissements actifs (à supprimer ou transférer d'abord).
   */
  async deleteAccount(userId: string, password: string, actor: Actor) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const valid = await verify(user.passwordHash, password).catch(() => false);
    if (!valid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Mot de passe incorrect',
      });
    }
    const owned = await this.prisma.restaurant.count({
      where: { ownerId: userId, deletedAt: null },
    });
    if (owned) {
      throw new ConflictException({
        code: 'OWNER_HAS_RESTAURANTS',
        message:
          'Supprimez ou transférez vos établissements avant de supprimer votre compte',
        details: { restaurants: owned },
      });
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: `supprime+${userId}@anonymise.invalid`,
          phone: null,
          firstName: 'Utilisateur',
          lastName: 'supprimé',
          passwordHash: await hash(randomToken()),
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
          status: 'SUSPENDED',
          deletedAt: now,
        },
      }),
      this.prisma.membership.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: now, pinHash: null },
      }),
      this.prisma.otpCode.deleteMany({ where: { userId } }),
      this.prisma.refreshToken.updateMany({
        where: { userId },
        data: { revokedAt: now, ip: null, userAgent: null },
      }),
    ]);
    await this.audit.log({
      action: 'privacy.account_deleted',
      entity: 'User',
      entityId: userId,
      actorId: actor.id,
    });
  }

  /**
   * Anonymise les données d'un client final d'un établissement, sur sa demande
   * (téléphone utilisé lors de ses commandes). Les montants sont conservés.
   */
  async anonymizeCustomer(restaurantId: string, phone: string, actor: Actor) {
    const orders = await this.prisma.order.findMany({
      where: { restaurantId, customerPhone: phone },
      select: { id: true },
    });
    const ids = orders.map((o) => o.id);
    const [updatedOrders, updatedPayments] = await this.prisma.$transaction([
      this.prisma.order.updateMany({
        where: { id: { in: ids } },
        data: { customerName: null, customerPhone: null },
      }),
      this.prisma.payment.updateMany({
        where: { orderId: { in: ids } },
        data: { payerPhone: null },
      }),
    ]);
    await this.audit.log({
      action: 'privacy.customer_anonymized',
      entity: 'Order',
      restaurantId,
      actorId: actor.id,
      after: { orders: updatedOrders.count }, // le numéro n'est volontairement pas journalisé
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { orders: updatedOrders.count, payments: updatedPayments.count };
  }
}
