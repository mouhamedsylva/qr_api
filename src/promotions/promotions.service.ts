import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LoyaltyReward, Prisma, Promotion } from '@prisma/client';
import { randomBytes } from 'crypto';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeDiscount, DiscountLine } from './discount';
import { CreatePromotionDto, UpdatePromotionDto } from './dto/promotions.dto';

/** Durée de validité d'un bon de fidélité. */
export const VOUCHER_VALIDITY_DAYS = 90;

export interface PromoCustomer {
  customerId?: string | null;
  customerPhone?: string | null;
}

@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  // ───────────────────────── Gestion (CMD-13) ─────────────────────────

  list(restaurantId: string) {
    return this.prisma.promotion.findMany({
      where: { restaurantId, deletedAt: null, source: 'MANUAL' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(restaurantId: string, dto: CreatePromotionDto, actorId: string) {
    await this.assertMenuItem(restaurantId, dto.menuItemId);
    this.assertDates(dto.startsAt, dto.endsAt);
    const existing = await this.prisma.promotion.findUnique({
      where: { restaurantId_code: { restaurantId, code: dto.code } },
    });
    if (existing) {
      throw new ConflictException({
        code: 'PROMO_CODE_TAKEN',
        message: 'Ce code promo existe déjà',
      });
    }
    return this.prisma.promotion.create({
      data: {
        ...dto,
        value: dto.value ?? 0,
        restaurantId,
        createdById: actorId,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  async update(restaurantId: string, id: string, dto: UpdatePromotionDto) {
    const promo = await this.getOrThrow(restaurantId, id);
    await this.assertMenuItem(restaurantId, dto.menuItemId);
    this.assertDates(
      dto.startsAt ?? promo.startsAt?.toISOString(),
      dto.endsAt ?? promo.endsAt?.toISOString(),
    );
    return this.prisma.promotion.update({
      where: { id },
      data: {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  async remove(restaurantId: string, id: string) {
    await this.getOrThrow(restaurantId, id);
    await this.prisma.promotion.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ───────────────────────── Application aux commandes ─────────────────────────

  /**
   * Valide un code pour un panier et calcule la remise. Lève une erreur
   * explicite (code expiré, épuisé, panier insuffisant…) pour le client.
   */
  async resolve(
    restaurantId: string,
    rawCode: string,
    customer: PromoCustomer,
    lines: DiscountLine[],
    subtotal: number,
  ): Promise<{ promotion: Promotion; discount: number }> {
    const code = rawCode.trim().toUpperCase();
    const now = new Date();
    const promotion = await this.prisma.promotion.findUnique({
      where: { restaurantId_code: { restaurantId, code } },
    });
    const usable =
      promotion &&
      promotion.isActive &&
      !promotion.deletedAt &&
      (!promotion.startsAt || promotion.startsAt <= now) &&
      (!promotion.endsAt || promotion.endsAt > now) &&
      (!promotion.customerId || promotion.customerId === customer.customerId);
    if (!usable)
      throw promoError('PROMO_INVALID', 'Code promo invalide ou expiré');

    // Les codes manuels relèvent du forfait ; les bons de fidélité, de la fidélité.
    const feature = promotion.source === 'LOYALTY' ? 'loyalty' : 'promotions';
    const { ownerId } = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { ownerId: true },
    });
    if (!(await this.billing.hasFeature(ownerId, feature))) {
      throw promoError('PROMO_INVALID', 'Code promo invalide ou expiré');
    }
    if (
      promotion.usageLimit !== null &&
      promotion.usageCount >= promotion.usageLimit
    ) {
      throw promoError(
        'PROMO_EXHAUSTED',
        'Ce code promo a atteint sa limite d’utilisation',
      );
    }
    if (promotion.perCustomerLimit !== null) {
      if (!customer.customerId && !customer.customerPhone) {
        throw promoError(
          'PROMO_REQUIRES_IDENTIFICATION',
          'Connectez-vous ou indiquez votre téléphone pour utiliser ce code',
        );
      }
      const used = await this.prisma.promotionRedemption.count({
        where: {
          promotionId: promotion.id,
          releasedAt: null,
          OR: [
            ...(customer.customerId
              ? [{ customerId: customer.customerId }]
              : []),
            ...(customer.customerPhone
              ? [{ customerPhone: customer.customerPhone }]
              : []),
          ],
        },
      });
      if (used >= promotion.perCustomerLimit) {
        throw promoError(
          'PROMO_LIMIT_REACHED',
          'Vous avez déjà utilisé ce code',
        );
      }
    }
    if (promotion.minSubtotal !== null && subtotal < promotion.minSubtotal) {
      throw promoError(
        'PROMO_MIN_SUBTOTAL',
        `Montant minimum de commande : ${promotion.minSubtotal}`,
        { minSubtotal: promotion.minSubtotal },
      );
    }
    const discount = computeDiscount(promotion, lines, subtotal);
    if (discount === 0) {
      throw promoError(
        'PROMO_NOT_APPLICABLE',
        'Ce code ne s’applique pas aux articles de votre panier',
      );
    }
    return { promotion, discount };
  }

  /** Consomme une utilisation, de façon atomique, dans la transaction de commande. */
  async reserve(
    tx: Prisma.TransactionClient,
    promotion: Promotion,
    orderId: string,
    discount: number,
    customer: PromoCustomer,
  ) {
    const res = await tx.promotion.updateMany({
      where: {
        id: promotion.id,
        ...(promotion.usageLimit !== null && {
          usageCount: { lt: promotion.usageLimit },
        }),
      },
      data: { usageCount: { increment: 1 } },
    });
    if (res.count === 0) {
      throw promoError(
        'PROMO_EXHAUSTED',
        'Ce code promo a atteint sa limite d’utilisation',
      );
    }
    await tx.promotionRedemption.create({
      data: {
        promotionId: promotion.id,
        orderId,
        discount,
        customerId: customer.customerId ?? null,
        customerPhone: customer.customerPhone ?? null,
      },
    });
  }

  /** Commande annulée ou refusée : l'utilisation du code est rendue. */
  async release(tx: Prisma.TransactionClient, orderId: string) {
    const redemption = await tx.promotionRedemption.findUnique({
      where: { orderId },
    });
    if (!redemption || redemption.releasedAt) return;
    await tx.promotionRedemption.update({
      where: { id: redemption.id },
      data: { releasedAt: new Date() },
    });
    await tx.promotion.update({
      where: { id: redemption.promotionId },
      data: { usageCount: { decrement: 1 } },
    });
  }

  /** Bon nominatif à usage unique, émis contre des points de fidélité. */
  createVoucher(
    tx: Prisma.TransactionClient,
    reward: LoyaltyReward,
    customerId: string,
  ) {
    return tx.promotion.create({
      data: {
        restaurantId: reward.restaurantId,
        code: `FID-${randomBytes(4).toString('hex').toUpperCase()}`,
        name: reward.name,
        type: reward.type,
        value: reward.value,
        menuItemId: reward.menuItemId,
        // « 1 offert pour 0 acheté » : un exemplaire de l'article.
        ...(reward.type === 'BUY_X_GET_Y' && {
          buyQuantity: 1,
          freeQuantity: 1,
        }),
        usageLimit: 1,
        perCustomerLimit: 1,
        customerId,
        source: 'LOYALTY',
        endsAt: new Date(Date.now() + VOUCHER_VALIDITY_DAYS * 86_400_000),
      },
    });
  }

  // ───────────────────────── Interne ─────────────────────────

  private async getOrThrow(restaurantId: string, id: string) {
    const promo = await this.prisma.promotion.findFirst({
      where: { id, restaurantId, deletedAt: null, source: 'MANUAL' },
    });
    if (!promo) throw new NotFoundException('Promotion introuvable');
    return promo;
  }

  private async assertMenuItem(restaurantId: string, menuItemId?: string) {
    if (!menuItemId) return;
    const exists = await this.prisma.menuItem.count({
      where: { id: menuItemId, restaurantId, deletedAt: null },
    });
    if (!exists) {
      throw new BadRequestException({
        code: 'INVALID_MENU_ITEM',
        message: 'Article introuvable',
      });
    }
  }

  private assertDates(startsAt?: string, endsAt?: string) {
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      throw new BadRequestException({
        code: 'INVALID_PERIOD',
        message: 'La date de fin doit être postérieure à la date de début',
      });
    }
  }
}

function promoError(code: string, message: string, details?: unknown) {
  return new BadRequestException({ code, message, details });
}
