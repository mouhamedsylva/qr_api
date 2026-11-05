import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LoyaltyAccount, LoyaltyProgram, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';
import {
  AdjustPointsDto,
  CreateRewardDto,
  UpdateRewardDto,
  UpsertLoyaltyProgramDto,
} from './dto/loyalty.dto';
import { isExpired, pointsForAmount } from './loyalty-rules';

const REWARD_SELECT = {
  id: true,
  name: true,
  description: true,
  pointsCost: true,
  type: true,
  value: true,
  menuItemId: true,
} satisfies Prisma.LoyaltyRewardSelect;

/**
 * Programme de fidélité par établissement (CLI-02), réservé aux clients
 * ayant un compte. Points gagnés au règlement complet d'une commande,
 * échangés contre un bon nominatif à usage unique.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly promotions: PromotionsService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Configuration ─────────────────────────

  async getProgram(restaurantId: string) {
    const [program, rewards] = await Promise.all([
      this.prisma.loyaltyProgram.findUnique({ where: { restaurantId } }),
      this.listRewards(restaurantId),
    ]);
    return { program, rewards };
  }

  upsertProgram(restaurantId: string, dto: UpsertLoyaltyProgramDto) {
    return this.prisma.loyaltyProgram.upsert({
      where: { restaurantId },
      create: { ...dto, restaurantId },
      update: dto,
    });
  }

  listRewards(restaurantId: string) {
    return this.prisma.loyaltyReward.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: { pointsCost: 'asc' },
    });
  }

  async createReward(restaurantId: string, dto: CreateRewardDto) {
    await this.assertMenuItem(restaurantId, dto.menuItemId);
    return this.prisma.loyaltyReward.create({
      data: { ...dto, value: dto.value ?? 0, restaurantId },
    });
  }

  async updateReward(restaurantId: string, id: string, dto: UpdateRewardDto) {
    await this.getReward(restaurantId, id);
    await this.assertMenuItem(restaurantId, dto.menuItemId);
    return this.prisma.loyaltyReward.update({ where: { id }, data: dto });
  }

  async removeReward(restaurantId: string, id: string) {
    await this.getReward(restaurantId, id);
    await this.prisma.loyaltyReward.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async listAccounts(restaurantId: string) {
    return this.prisma.loyaltyAccount.findMany({
      where: { restaurantId },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { lifetimePoints: 'desc' },
      take: 500,
    });
  }

  async adjust(restaurantId: string, dto: AdjustPointsDto, actor: Actor) {
    const user = await this.prisma.user.count({
      where: { id: dto.userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Client introuvable');
    const account = await this.prisma.$transaction(async (tx) => {
      const account = await this.accountFor(tx, restaurantId, dto.userId);
      if (account.points + dto.points < 0) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_POINTS',
          message: 'Le solde ne peut pas devenir négatif',
        });
      }
      await tx.loyaltyTransaction.create({
        data: {
          accountId: account.id,
          type: 'ADJUST',
          points: dto.points,
          note: dto.note,
          createdById: actor.id,
        },
      });
      return tx.loyaltyAccount.update({
        where: { id: account.id },
        data: {
          points: { increment: dto.points },
          ...(dto.points > 0 && { lifetimePoints: { increment: dto.points } }),
          lastActivityAt: new Date(),
        },
      });
    });
    await this.audit.log({
      action: 'loyalty.adjust',
      entity: 'LoyaltyAccount',
      entityId: account.id,
      restaurantId,
      actorId: actor.id,
      after: { userId: dto.userId, points: dto.points, note: dto.note },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return account;
  }

  // ───────────────────────── Côté client ─────────────────────────

  /** Programme public d'un établissement (affiché avant inscription). */
  async publicProgram(slug: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, ownerId: true, loyaltyProgram: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant introuvable');
    const program = restaurant.loyaltyProgram;
    if (
      !program?.isActive ||
      !(await this.billing.hasFeature(restaurant.ownerId, 'loyalty'))
    ) {
      return { active: false };
    }
    return {
      active: true,
      pointsPerUnit: program.pointsPerUnit,
      unitAmount: program.unitAmount,
      expiryDays: program.expiryDays,
      rewards: await this.prisma.loyaltyReward.findMany({
        where: { restaurantId: restaurant.id, deletedAt: null, isActive: true },
        select: REWARD_SELECT,
        orderBy: { pointsCost: 'asc' },
      }),
    };
  }

  /** Comptes fidélité du client, tous établissements confondus. */
  async myAccounts(userId: string) {
    const accounts = await this.prisma.loyaltyAccount.findMany({
      where: { userId },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            slug: true,
            loyaltyProgram: true,
            loyaltyRewards: {
              where: { deletedAt: null, isActive: true },
              select: REWARD_SELECT,
              orderBy: { pointsCost: 'asc' },
            },
          },
        },
      },
    });
    const result: unknown[] = [];
    for (const a of accounts) {
      const points = await this.prisma.$transaction((tx) =>
        this.expireIfInactive(tx, a, a.restaurant.loyaltyProgram),
      );
      const vouchers = await this.prisma.promotion.findMany({
        where: {
          restaurantId: a.restaurantId,
          customerId: userId,
          source: 'LOYALTY',
          usageCount: 0,
          endsAt: { gt: new Date() },
        },
        select: { code: true, name: true, endsAt: true },
      });
      result.push({
        restaurant: {
          id: a.restaurant.id,
          name: a.restaurant.name,
          slug: a.restaurant.slug,
        },
        points,
        lifetimePoints: a.lifetimePoints,
        rewards: a.restaurant.loyaltyRewards.map((r) => ({
          ...r,
          affordable: r.pointsCost <= points,
        })),
        vouchers,
      });
    }
    return result;
  }

  /** Échange de points contre un bon de réduction nominatif. */
  async redeem(userId: string, restaurantId: string, rewardId: string) {
    const program = await this.activeProgram(restaurantId);
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id: rewardId, restaurantId, deletedAt: null, isActive: true },
    });
    if (!reward) throw new NotFoundException('Récompense introuvable');

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.loyaltyAccount.findUnique({
        where: { restaurantId_userId: { restaurantId, userId } },
      });
      const balance = account
        ? await this.expireIfInactive(tx, account, program)
        : 0;
      // Décrément conditionnel : deux échanges simultanés ne peuvent pas rendre le solde négatif.
      const debited = account
        ? await tx.loyaltyAccount.updateMany({
            where: { id: account.id, points: { gte: reward.pointsCost } },
            data: {
              points: { decrement: reward.pointsCost },
              lastActivityAt: new Date(),
            },
          })
        : { count: 0 };
      if (!account || debited.count === 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_POINTS',
          message: 'Points insuffisants pour cette récompense',
          details: { points: balance, required: reward.pointsCost },
        });
      }
      const voucher = await this.promotions.createVoucher(tx, reward, userId);
      await tx.loyaltyTransaction.create({
        data: {
          accountId: account.id,
          type: 'REDEEM',
          points: -reward.pointsCost,
          promotionId: voucher.id,
          note: reward.name,
        },
      });
      return {
        code: voucher.code,
        reward: reward.name,
        expiresAt: voucher.endsAt,
        remainingPoints: balance - reward.pointsCost,
      };
    });
  }

  // ─────────────────── Hooks de paiement (appelés en transaction) ───────────────────

  /** Commande entièrement réglée : crédit des points au client connecté. */
  async onOrderPaid(tx: Prisma.TransactionClient, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        customerId: true,
        restaurantId: true,
        total: true,
        tipAmount: true,
        restaurant: { select: { ownerId: true, loyaltyProgram: true } },
      },
    });
    const program = order.restaurant.loyaltyProgram;
    if (!order.customerId || !program?.isActive) return;
    if (!(await this.billing.hasFeature(order.restaurant.ownerId, 'loyalty')))
      return;
    const alreadyEarned = await tx.loyaltyTransaction.count({
      where: { orderId, type: 'EARN' },
    });
    if (alreadyEarned) return;

    const points = pointsForAmount(order.total - order.tipAmount, program);
    if (points === 0) return;
    const account = await this.accountFor(
      tx,
      order.restaurantId,
      order.customerId,
    );
    await this.expireIfInactive(tx, account, program);
    await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: {
        points: { increment: points },
        lifetimePoints: { increment: points },
        lastActivityAt: new Date(),
      },
    });
    await tx.loyaltyTransaction.create({
      data: { accountId: account.id, type: 'EARN', points, orderId },
    });
  }

  /** Commande intégralement remboursée : les points gagnés sont repris. */
  async onOrderRefunded(tx: Prisma.TransactionClient, orderId: string) {
    const earned = await tx.loyaltyTransaction.findFirst({
      where: { orderId, type: 'EARN' },
      include: { account: true },
    });
    if (!earned) return;
    const reversed = await tx.loyaltyTransaction.count({
      where: { orderId, type: 'REVERSAL' },
    });
    if (reversed) return;
    const points = Math.min(earned.points, earned.account.points);
    await tx.loyaltyAccount.update({
      where: { id: earned.accountId },
      data: { points: { decrement: points } },
    });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: earned.accountId,
        type: 'REVERSAL',
        points: -points,
        orderId,
        note: 'Commande remboursée',
      },
    });
  }

  // ───────────────────────── Interne ─────────────────────────

  private async activeProgram(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { ownerId: true, loyaltyProgram: true },
    });
    const program = restaurant.loyaltyProgram;
    if (
      !program?.isActive ||
      !(await this.billing.hasFeature(restaurant.ownerId, 'loyalty'))
    ) {
      throw new ConflictException({
        code: 'LOYALTY_UNAVAILABLE',
        message: "Cet établissement n'a pas de programme de fidélité actif",
      });
    }
    return program;
  }

  private async accountFor(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    userId: string,
  ) {
    return tx.loyaltyAccount.upsert({
      where: { restaurantId_userId: { restaurantId, userId } },
      create: { restaurantId, userId },
      update: {},
    });
  }

  /** Applique l'expiration paresseusement ; renvoie le solde à jour. */
  private async expireIfInactive(
    tx: Prisma.TransactionClient,
    account: LoyaltyAccount,
    program: LoyaltyProgram | null,
  ): Promise<number> {
    if (
      account.points <= 0 ||
      !isExpired(account.lastActivityAt, program?.expiryDays ?? null)
    ) {
      return account.points;
    }
    const res = await tx.loyaltyAccount.updateMany({
      where: { id: account.id, points: account.points },
      data: { points: 0, lastActivityAt: new Date() },
    });
    if (res.count) {
      await tx.loyaltyTransaction.create({
        data: {
          accountId: account.id,
          type: 'EXPIRE',
          points: -account.points,
          note: `Points expirés après ${program?.expiryDays} jours d'inactivité`,
        },
      });
    }
    return 0;
  }

  private async getReward(restaurantId: string, id: string) {
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id, restaurantId, deletedAt: null },
    });
    if (!reward) throw new NotFoundException('Récompense introuvable');
    return reward;
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
}
