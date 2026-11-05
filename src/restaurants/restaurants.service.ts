import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Restaurant } from '@prisma/client';
import { randomBytes } from 'crypto';
import { BillingService } from '../billing/billing.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/types/request-context';
import { slugify } from '../common/utils/slug.util';
import {
  PermissionOverrides,
  resolvePermissions,
} from '../auth/rbac/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateClosureDto,
  CreateRestaurantDto,
  SetOpeningHoursDto,
} from './dto/restaurant.dto';
import { computeOpenStatus, startOfLocalDay } from './schedule';

/** Horaires créés par défaut à l'inscription : tous les jours 08:00–23:00. */
const DEFAULT_HOURS = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  opensAt: '08:00',
  closesAt: '23:00',
}));

/** Champs exposés publiquement à la PWA client. */
const PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  address: true,
  city: true,
  country: true,
  phone: true,
  logoUrl: true,
  bannerUrl: true,
  socialLinks: true,
  brandColors: true,
  menuTheme: true,
  currency: true,
  locale: true,
  timezone: true,
  priceFormat: true,
  taxEnabled: true,
  taxRateBp: true,
  pricesIncludeTax: true,
  serviceFeeBp: true,
} satisfies Prisma.RestaurantSelect;

@Injectable()
export class RestaurantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  /** Crée un établissement, son OWNER et ses horaires par défaut (dans une transaction). */
  async createForOwner(
    tx: Prisma.TransactionClient,
    ownerId: string,
    dto: CreateRestaurantDto,
  ): Promise<Restaurant> {
    const slug = await this.generateUniqueSlug(tx, dto.name);
    const restaurant = await tx.restaurant.create({
      data: {
        ...dto,
        slug,
        ownerId,
        createdById: ownerId,
        openingHours: { create: DEFAULT_HOURS },
      },
    });
    await tx.membership.create({
      data: {
        userId: ownerId,
        restaurantId: restaurant.id,
        role: 'OWNER',
        createdById: ownerId,
      },
    });
    return restaurant;
  }

  async create(dto: CreateRestaurantDto, actor: Actor) {
    await this.billing.assertOwnerQuota(actor.id);
    return this.prisma.$transaction(async (tx) => {
      const restaurant = await this.createForOwner(tx, actor.id, dto);
      await this.audit.log(
        {
          action: 'restaurant.create',
          entity: 'Restaurant',
          entityId: restaurant.id,
          restaurantId: restaurant.id,
          actorId: actor.id,
          after: restaurant,
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      return restaurant;
    });
  }

  private async generateUniqueSlug(
    tx: Prisma.TransactionClient,
    name: string,
  ): Promise<string> {
    const base = slugify(name) || 'restaurant';
    let slug = base;
    for (let i = 0; i < 5; i++) {
      const exists = await tx.restaurant.findUnique({ where: { slug } });
      if (!exists) return slug;
      slug = `${base}-${randomBytes(3).toString('hex')}`;
    }
    return `${base}-${randomBytes(6).toString('hex')}`;
  }

  /** Établissements de l'utilisateur avec son rôle et ses permissions effectives. */
  async listForUser(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, deletedAt: null, restaurant: { deletedAt: null } },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            city: true,
            status: true,
            currency: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      ...m.restaurant,
      role: m.role,
      staffProfile: m.staffProfile,
      permissions: [
        ...resolvePermissions(
          m.role,
          m.permissions as PermissionOverrides | null,
        ),
      ],
    }));
  }

  async findOne(id: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, deletedAt: null },
      include: {
        openingHours: { orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }] },
      },
    });
    if (!restaurant) {
      throw new NotFoundException('Restaurant introuvable');
    }
    return restaurant;
  }

  /**
   * Mise à jour partielle avec journalisation avant/après (RES-01 à RES-04).
   * Seuls les champs réellement modifiés sont journalisés.
   */
  async update(
    id: string,
    data: Prisma.RestaurantUpdateInput,
    actor: Actor,
    action: string,
  ) {
    const before = await this.findOne(id);
    const updated = await this.prisma.restaurant.update({
      where: { id },
      data: data,
    });

    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      const prev = (before as Record<string, unknown>)[key];
      const next = (updated as Record<string, unknown>)[key];
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        changedBefore[key] = prev;
        changedAfter[key] = next;
      }
    }
    if (Object.keys(changedAfter).length) {
      await this.audit.log({
        action,
        entity: 'Restaurant',
        entityId: id,
        restaurantId: id,
        actorId: actor.id,
        before: changedBefore,
        after: changedAfter,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }
    return updated;
  }

  async setOpeningHours(id: string, dto: SetOpeningHoursDto) {
    await this.prisma.$transaction([
      this.prisma.openingHour.deleteMany({ where: { restaurantId: id } }),
      this.prisma.openingHour.createMany({
        data: dto.hours.map((h) => ({ ...h, restaurantId: id })),
      }),
    ]);
    return this.prisma.openingHour.findMany({
      where: { restaurantId: id },
      orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
    });
  }

  listClosures(restaurantId: string) {
    return this.prisma.closurePeriod.findMany({
      where: { restaurantId, deletedAt: null, endsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
    });
  }

  async addClosure(
    restaurantId: string,
    dto: CreateClosureDto,
    actorId: string,
  ) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw new BadRequestException({
        code: 'INVALID_PERIOD',
        message: 'La date de fin doit être postérieure à la date de début',
      });
    }
    return this.prisma.closurePeriod.create({
      data: {
        restaurantId,
        startsAt,
        endsAt,
        reason: dto.reason,
        createdById: actorId,
      },
    });
  }

  async removeClosure(restaurantId: string, closureId: string) {
    // Filtrer par restaurantId empêche de supprimer la fermeture d'un autre tenant.
    const result = await this.prisma.closurePeriod.updateMany({
      where: { id: closureId, restaurantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException('Fermeture introuvable');
    }
  }

  async openStatus(restaurantId: string, now = new Date()) {
    const restaurant = await this.prisma.restaurant.findFirstOrThrow({
      where: { id: restaurantId, deletedAt: null },
      select: {
        timezone: true,
        openingHours: true,
        closurePeriods: {
          where: { deletedAt: null, endsAt: { gt: now } },
        },
      },
    });
    return computeOpenStatus(
      restaurant.openingHours,
      restaurant.closurePeriods,
      restaurant.timezone,
      now,
    );
  }

  /**
   * Tableau de bord temps réel (RES-05) : activité depuis minuit, heure locale.
   * Les commandes annulées ou refusées sont exclues du chiffre d'affaires.
   * `staffPresent` sera alimenté par le pointage (EQP-05).
   */
  async dashboard(restaurantId: string) {
    const now = new Date();
    const restaurant = await this.findOne(restaurantId);
    const since = startOfLocalDay(now, restaurant.timezone);
    const [status, sales, inProgress, tablesOccupied] = await Promise.all([
      this.openStatus(restaurantId, now),
      this.prisma.order.aggregate({
        where: {
          restaurantId,
          createdAt: { gte: since },
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.order.count({
        where: {
          restaurantId,
          status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] },
        },
      }),
      this.prisma.diningTable.count({
        where: { restaurantId, deletedAt: null, status: { not: 'FREE' } },
      }),
    ]);
    const salesTotal = sales._sum.total ?? 0;
    return {
      since,
      currency: restaurant.currency,
      isOpen: status.isOpen,
      salesTotal,
      ordersCount: sales._count,
      ordersInProgress: inProgress,
      averageBasket: sales._count ? Math.round(salesTotal / sales._count) : 0,
      tablesOccupied,
      staffPresent: 0,
    };
  }

  async softDelete(id: string, actor: Actor) {
    await this.prisma.restaurant.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.audit.log({
      action: 'restaurant.delete',
      entity: 'Restaurant',
      entityId: id,
      restaurantId: id,
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  async findPublicBySlug(slug: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug, deletedAt: null, status: 'ACTIVE' },
      select: {
        ...PUBLIC_SELECT,
        openingHours: {
          select: { dayOfWeek: true, opensAt: true, closesAt: true },
          orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
        },
      },
    });
    if (!restaurant) {
      throw new NotFoundException('Restaurant introuvable');
    }
    const { id, ...rest } = restaurant;
    return { ...rest, ...(await this.openStatus(id)) };
  }
}
