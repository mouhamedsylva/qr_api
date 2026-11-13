import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RestaurantStatus, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import { BillingService } from '../billing/billing.service';
import { paginate } from '../common/dto/pagination.dto';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePlanDto,
  ListRestaurantsQueryDto,
  UpdatePlanDto,
  UpdateSubscriptionDto,
} from './dto/admin.dto';

const DAY_MS = 86_400_000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────── Établissements (ADM-01, ADM-02) ─────────────────────

  async listRestaurants(query: ListRestaurantsQueryDto) {
    const where: Prisma.RestaurantWhereInput = {
      deletedAt: null,
      ...(query.status && { status: query.status }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search } },
          { slug: { contains: query.search } },
          { city: { contains: query.search } },
          { owner: { email: { contains: query.search } } },
        ],
      }),
    };
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [restaurants, total] = await this.prisma.$transaction([
      this.prisma.restaurant.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          city: true,
          country: true,
          status: true,
          currency: true,
          createdAt: true,
          owner: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              subscription: {
                select: {
                  status: true,
                  trialEndsAt: true,
                  currentPeriodEnd: true,
                  requestedAt: true,
                  requestedCycle: true,
                  plan: { select: { code: true } },
                  requestedPlan: { select: { code: true, name: true } },
                },
              },
            },
          },
          _count: {
            select: {
              orders: { where: { createdAt: { gte: since } } },
              tables: { where: { deletedAt: null } },
              memberships: { where: { deletedAt: null } },
            },
          },
        },
        orderBy: { createdAt: query.order },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.restaurant.count({ where }),
    ]);
    return paginate(restaurants, total, query);
  }

  async setRestaurantStatus(
    id: string,
    status: RestaurantStatus,
    reason: string,
    actor: Actor,
  ) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, deletedAt: null },
    });
    if (!restaurant) throw new NotFoundException('Restaurant introuvable');
    const updated = await this.prisma.restaurant.update({
      where: { id },
      data: { status },
      select: { id: true, name: true, status: true },
    });
    await this.audit.log({
      action: 'admin.restaurant_status',
      entity: 'Restaurant',
      entityId: id,
      restaurantId: id,
      actorId: actor.id,
      before: { status: restaurant.status },
      after: { status, reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return updated;
  }

  /**
   * Suppression d'un restaurant par un super-admin (ADM-02). Suppression
   * logique, comme celle faite par le propriétaire : le restaurant n'est plus
   * accessible (menu, QR codes, back-office), ses commandes et paiements restent
   * dans l'historique. Le motif est conservé dans le journal d'audit.
   */
  async deleteRestaurant(id: string, reason: string, actor: Actor) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, slug: true, status: true, ownerId: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant introuvable');
    await this.prisma.restaurant.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.audit.log({
      action: 'admin.restaurant_delete',
      entity: 'Restaurant',
      entityId: id,
      restaurantId: id,
      actorId: actor.id,
      before: {
        name: restaurant.name,
        slug: restaurant.slug,
        status: restaurant.status,
      },
      after: { deleted: true, reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  /** Suspension d'un compte : ses sessions sont fermées immédiatement. */
  async setUserStatus(
    id: string,
    status: UserStatus,
    reason: string,
    actor: Actor,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    if (user.isSuperAdmin || user.id === actor.id) {
      throw new ConflictException({
        code: 'CANNOT_MODERATE_ADMIN',
        message: 'Un compte administrateur ne peut pas être suspendu ici',
      });
    }
    await this.prisma.user.update({ where: { id }, data: { status } });
    if (status === 'SUSPENDED') {
      await this.tokens.revokeAllForUser(id);
    }
    await this.audit.log({
      action: 'admin.user_status',
      entity: 'User',
      entityId: id,
      actorId: actor.id,
      before: { status: user.status },
      after: { status, reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { id, status };
  }

  // ───────────────────────── Analytics (ADM-03) ─────────────────────────

  /**
   * Indicateurs plateforme sur 30 jours. GMV et MRR sont ventilés par devise
   * (pas de conversion implicite entre XOF, EUR…).
   */
  async analytics() {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * DAY_MS);

    const [
      restaurantsByStatus,
      newRestaurants,
      ordersCount,
      gmv,
      subscriptionsByStatus,
      activeSubscriptions,
      cancelledRecently,
    ] = await Promise.all([
      this.prisma.restaurant.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: true,
      }),
      this.prisma.restaurant.count({
        where: { deletedAt: null, createdAt: { gte: since } },
      }),
      this.prisma.order.count({ where: { createdAt: { gte: since } } }),
      this.prisma.order.groupBy({
        by: ['currency'],
        where: {
          createdAt: { gte: since },
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
        _sum: { total: true },
      }),
      this.prisma.subscription.groupBy({ by: ['status'], _count: true }),
      this.prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        include: { plan: true },
      }),
      this.prisma.subscription.count({
        where: { status: 'CANCELLED', updatedAt: { gte: since } },
      }),
    ]);

    const mrr: Record<string, number> = {};
    for (const sub of activeSubscriptions) {
      const monthly =
        sub.billingCycle === 'YEARLY'
          ? Math.round(sub.plan.priceYearly / 12)
          : sub.plan.priceMonthly;
      mrr[sub.plan.currency] = (mrr[sub.plan.currency] ?? 0) + monthly;
    }
    const base = activeSubscriptions.length + cancelledRecently;

    return {
      period: { from: since, to: now },
      restaurants: {
        byStatus: Object.fromEntries(
          restaurantsByStatus.map((r) => [r.status, r._count]),
        ),
        new: newRestaurants,
      },
      orders: { count: ordersCount },
      gmv: Object.fromEntries(gmv.map((g) => [g.currency, g._sum.total ?? 0])),
      subscriptions: Object.fromEntries(
        subscriptionsByStatus.map((s) => [s.status, s._count]),
      ),
      mrr,
      churnRate: base
        ? Math.round((cancelledRecently / base) * 10_000) / 100
        : 0,
    };
  }

  // ─────────────────────── Forfaits & abonnements ───────────────────────

  listPlans() {
    return this.prisma.plan.findMany({ orderBy: { position: 'asc' } });
  }

  async createPlan(dto: CreatePlanDto, actor: Actor) {
    const last = await this.prisma.plan.aggregate({ _max: { position: true } });
    const plan = await this.prisma.plan.create({
      data: { ...dto, position: (last._max.position ?? -1) + 1 },
    });
    await this.logPlan('admin.plan_create', plan.id, null, plan, actor);
    return plan;
  }

  async updatePlan(code: string, dto: UpdatePlanDto, actor: Actor) {
    const before = await this.billing.planByCode(code);
    const plan = await this.prisma.plan.update({ where: { code }, data: dto });
    await this.logPlan('admin.plan_update', plan.id, before, plan, actor);
    return plan;
  }

  async updateSubscription(
    userId: string,
    dto: UpdateSubscriptionDto,
    actor: Actor,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { subscription: { include: { plan: true } } },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    const subscription = await this.billing.updateAsAdmin(userId, {
      planCode: dto.planCode,
      status: dto.status,
      billingCycle: dto.billingCycle,
      currentPeriodEnd: dto.currentPeriodEnd
        ? new Date(dto.currentPeriodEnd)
        : undefined,
      graceUntil:
        dto.graceUntil === undefined
          ? undefined
          : dto.graceUntil
            ? new Date(dto.graceUntil)
            : null,
      force: dto.force,
    });
    await this.audit.log({
      action: 'admin.subscription_update',
      entity: 'Subscription',
      entityId: subscription.id,
      actorId: actor.id,
      before: user.subscription && {
        plan: user.subscription.plan.code,
        status: user.subscription.status,
      },
      after: { plan: subscription.plan.code, status: subscription.status },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return subscription;
  }

  private logPlan(
    action: string,
    planId: string,
    before: unknown,
    after: unknown,
    actor: Actor,
  ) {
    return this.audit.log({
      action,
      entity: 'Plan',
      entityId: planId,
      actorId: actor.id,
      before,
      after,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
}
