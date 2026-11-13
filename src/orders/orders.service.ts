import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderMode,
  OrderSource,
  OrderStatus,
  Prisma,
  TableStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { paginate } from '../common/dto/pagination.dto';
import { toCsv } from '../common/utils/csv.util';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { RealtimeEvents } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { PromotionsService } from '../promotions/promotions.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { QrTokenService } from '../tables/qr-token.service';
import {
  CreatePublicOrderDto,
  ListOrdersQueryDto,
  OrderLineDto,
} from './dto/orders.dto';
import { BuiltLine, buildOrderLines, OrderableMenuItem } from './order-lines';
import { signOrderToken } from './order-token';
import { computeTotals } from './order-totals';
import {
  ACTIVE_STATUSES,
  canTransition,
  REASON_REQUIRED,
  STOCK_RESTORABLE_FROM,
  TERMINAL_STATUSES,
  timestampFor,
} from './order-workflow';

export const ORDER_INCLUDE = {
  items: { orderBy: [{ batch: 'asc' }, { position: 'asc' }] },
  table: { select: { id: true, label: true } },
} satisfies Prisma.OrderInclude;

export type OrderWithItems = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

export interface OrderContext {
  restaurantId: string;
  mode: OrderMode;
  source: OrderSource;
  tableId?: string | null;
  createdById?: string;
  /** Client connecté à son compte (CLI-01). */
  customerId?: string | null;
}

export interface OrderInput {
  items: OrderLineDto[];
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  tipAmount?: number;
  promoCode?: string;
}

/** Temps de préparation par défaut d'un article sans durée renseignée. */
const DEFAULT_PREP_MINUTES = 15;
const EXPORT_LIMIT = 10_000;

@Injectable()
export class OrdersService {
  private readonly tokenSecret: string;

  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
    private readonly restaurants: RestaurantsService,
    private readonly qrTokens: QrTokenService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly promotions: PromotionsService,
    config: ConfigService,
  ) {
    this.tokenSecret = config.getOrThrow<string>('QR_SIGNING_SECRET');
  }

  trackingToken(orderId: string): string {
    return signOrderToken(this.tokenSecret, orderId);
  }

  // ───────────────────────── Création ─────────────────────────

  /**
   * Détermine l'établissement et la table d'une commande client :
   * QR de table (sur place), QR comptoir ou slug (à emporter).
   */
  async resolvePublicContext(dto: CreatePublicOrderDto): Promise<OrderContext> {
    if (dto.qrToken) {
      const payload = this.qrTokens.verify(dto.qrToken);
      const table =
        payload &&
        (await this.prisma.diningTable.findFirst({
          where: {
            id: payload.tableId,
            qrVersion: payload.version,
            deletedAt: null,
          },
          select: { id: true, kind: true, restaurantId: true },
        }));
      if (!table) {
        throw new BadRequestException({
          code: 'INVALID_QR',
          message: 'QR code invalide ou expiré',
        });
      }
      // Le client choisit sur place ou à emporter. La table n'est rattachée
      // qu'en sur place : une commande à emporter ne l'occupe pas. Sur place
      // depuis le QR comptoir = servi au comptoir, sans table.
      return {
        restaurantId: table.restaurantId,
        mode: dto.mode,
        source: 'CUSTOMER',
        tableId:
          table.kind === 'TABLE' && dto.mode === 'DINE_IN' ? table.id : null,
      };
    }

    // Lien direct vers le menu : sur place (au comptoir) ou à emporter, sans table.
    if (dto.restaurantSlug) {
      const restaurant = await this.prisma.restaurant.findFirst({
        where: { slug: dto.restaurantSlug, deletedAt: null },
        select: { id: true },
      });
      if (!restaurant) {
        throw new NotFoundException('Restaurant introuvable');
      }
      return {
        restaurantId: restaurant.id,
        mode: dto.mode,
        source: 'CUSTOMER',
      };
    }

    throw new BadRequestException({
      code: 'QR_REQUIRED',
      message:
        'Scannez le QR code du restaurant ou ouvrez son menu pour commander',
    });
  }

  /**
   * Crée une commande (CMD-01, CMD-05, CMD-12) de façon idempotente (CMD-16) :
   * la même clé renvoie la commande existante au lieu d'en créer une seconde.
   */
  async create(
    ctx: OrderContext,
    dto: OrderInput,
    idempotencyKey: string,
  ): Promise<{ order: OrderWithItems; replayed: boolean }> {
    const existing = await this.findByIdempotencyKey(
      ctx.restaurantId,
      idempotencyKey,
    );
    if (existing) return { order: existing, replayed: true };

    const { restaurant, lines, stockNeeded, totals, taxRateBp, promo } =
      await this.price(ctx, dto);
    const estimatedReadyAt = await this.estimateReadyAt(
      ctx.restaurantId,
      lines,
    );
    const promoCustomer = {
      customerId: ctx.customerId,
      customerPhone: dto.customerPhone,
    };

    let order: OrderWithItems;
    let tableUpdated = false;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        await decrementStock(tx, stockNeeded);
        const { orderSeq } = await tx.restaurant.update({
          where: { id: ctx.restaurantId },
          data: { orderSeq: { increment: 1 } },
          select: { orderSeq: true },
        });
        const created = await tx.order.create({
          data: {
            restaurantId: ctx.restaurantId,
            number: orderSeq,
            tableId: ctx.tableId ?? null,
            mode: ctx.mode,
            source: ctx.source,
            idempotencyKey,
            customerId: ctx.customerId ?? null,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
            notes: dto.notes,
            currency: restaurant.currency,
            ...totals,
            taxRateBp,
            pricesIncludeTax: restaurant.pricesIncludeTax,
            serviceFeeBp: restaurant.serviceFeeBp,
            promotionId: promo?.promotion.id,
            promoCode: promo?.promotion.code,
            // Entièrement couverte par une remise : rien à encaisser.
            ...(totals.total === 0 && {
              paymentStatus: 'PAID' as const,
              paidAt: new Date(),
            }),
            estimatedReadyAt,
            createdById: ctx.createdById,
            items: { create: lines.map((l, i) => toItemInput(l, i, 1)) },
          },
          include: ORDER_INCLUDE,
        });
        if (promo) {
          await this.promotions.reserve(
            tx,
            promo.promotion,
            created.id,
            promo.discount,
            promoCustomer,
          );
        }
        if (ctx.tableId) {
          // TAB-03 : la table passe en « commande en cours ».
          const res = await tx.diningTable.updateMany({
            where: {
              id: ctx.tableId,
              status: { in: [TableStatus.FREE, TableStatus.OCCUPIED] },
            },
            data: { status: 'ORDERING', statusChangedAt: new Date() },
          });
          tableUpdated = res.count > 0;
        }
        return created;
      });
    } catch (err) {
      // Deux requêtes simultanées avec la même clé : la seconde renvoie la première.
      if (isUniqueViolation(err, 'idempotencyKey')) {
        const winner = await this.findByIdempotencyKey(
          ctx.restaurantId,
          idempotencyKey,
        );
        if (winner) return { order: winner, replayed: true };
      }
      throw err;
    }

    await this.realtime.emit({
      restaurantId: order.restaurantId,
      orderId: order.id,
      type: RealtimeEvents.OrderCreated,
      payload: order,
    });
    if (tableUpdated && order.tableId) {
      await this.emitTable(order.restaurantId, order.tableId);
    }
    return { order, replayed: false };
  }

  /**
   * Devis du panier (récapitulatif avant paiement) : mêmes règles que la
   * création, remise et taxes comprises, sans rien enregistrer.
   */
  async quote(ctx: OrderContext, dto: OrderInput) {
    const { restaurant, lines, totals, promo } = await this.price(ctx, dto);
    return {
      currency: restaurant.currency,
      items: lines.map((l) => ({
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        options: l.options.map(({ groupName, name, priceDelta }) => ({
          groupName,
          name,
          priceDelta,
        })),
        lineTotal: l.lineTotal,
      })),
      promoCode: promo?.promotion.code ?? null,
      ...totals,
    };
  }

  /** Validation du contexte, construction des lignes, remise et totaux. */
  private async price(ctx: OrderContext, dto: OrderInput) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: ctx.restaurantId, deletedAt: null },
    });
    if (!restaurant || restaurant.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'RESTAURANT_UNAVAILABLE',
        message: "Cet établissement n'accepte pas de commandes",
      });
    }
    // Hors horaires, seul le staff peut encore saisir une commande (RES-06).
    // Sans abonnement valide, le restaurant ne prend plus de commandes clients.
    if (ctx.source === 'CUSTOMER') {
      await this.billing.assertRestaurantInService(restaurant.id);
      const status = await this.restaurants.openStatus(restaurant.id);
      if (!status.isOpen) {
        throw new ConflictException({
          code: 'RESTAURANT_CLOSED',
          message: "L'établissement est actuellement fermé",
          details: { reason: status.reason },
        });
      }
    }
    // Personnel : une commande sur place se rattache à une table. Client : sur
    // place sans table = servi au comptoir (QR comptoir ou lien du menu).
    if (ctx.mode === 'DINE_IN' && !ctx.tableId && ctx.source !== 'CUSTOMER') {
      throw new BadRequestException({
        code: 'TABLE_REQUIRED',
        message: 'Une commande sur place doit être rattachée à une table',
      });
    }
    if (ctx.tableId) {
      await this.assertTable(ctx.restaurantId, ctx.tableId);
    }

    const menu = await this.loadMenuItems(ctx.restaurantId, dto.items);
    const { lines, stockNeeded } = buildOrderLines(dto.items, menu);
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const promo = dto.promoCode
      ? await this.promotions.resolve(
          ctx.restaurantId,
          dto.promoCode,
          { customerId: ctx.customerId, customerPhone: dto.customerPhone },
          lines,
          subtotal,
        )
      : null;
    const taxRateBp = restaurant.taxEnabled ? restaurant.taxRateBp : 0;
    const totals = computeTotals(
      lines.map((l) => l.lineTotal),
      {
        taxEnabled: restaurant.taxEnabled,
        taxRateBp,
        pricesIncludeTax: restaurant.pricesIncludeTax,
        serviceFeeBp: restaurant.serviceFeeBp,
      },
      promo?.discount ?? 0,
      dto.tipAmount,
    );
    return { restaurant, lines, stockNeeded, totals, taxRateBp, promo };
  }

  /** Ajoute des articles à une commande ouverte (CMD-06). */
  async addItems(
    restaurantId: string,
    orderId: string,
    items: OrderLineDto[],
    batchKey: string,
  ): Promise<OrderWithItems> {
    const menu = await this.loadMenuItems(restaurantId, items);
    const { lines, stockNeeded } = buildOrderLines(items, menu);

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, restaurantId, orderId);
      // Rejeu de la même commande additionnelle : rien à faire.
      const replay = await tx.orderItem.findFirst({
        where: { orderId, batchKey },
        select: { id: true },
      });
      if (replay) return { order, added: false };

      if (TERMINAL_STATUSES.includes(order.status)) {
        throw new ConflictException({
          code: 'ORDER_CLOSED',
          message: 'Cette commande est clôturée',
        });
      }
      if (order.paymentStatus === 'PAID') {
        throw new ConflictException({
          code: 'ORDER_PAID',
          message: 'Commande déjà réglée : créez une nouvelle commande',
        });
      }

      await decrementStock(tx, stockNeeded);
      const batch = Math.max(...order.items.map((i) => i.batch), 0) + 1;
      await tx.orderItem.createMany({
        data: lines.map((l, i) => ({
          ...toItemInput(l, i, batch, batchKey),
          orderId,
        })),
      });

      const allLines = [
        ...order.items.map((i) => i.lineTotal),
        ...lines.map((l) => l.lineTotal),
      ];
      const totals = computeTotals(
        allLines,
        {
          taxEnabled: true,
          taxRateBp: order.taxRateBp,
          pricesIncludeTax: order.pricesIncludeTax,
          serviceFeeBp: order.serviceFeeBp,
        },
        order.discountTotal,
        order.tipAmount,
      );
      // Les nouveaux articles doivent être préparés : la commande repart en cuisine.
      const backToKitchen =
        order.status === 'READY' || order.status === 'SERVED';
      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          ...totals,
          ...(backToKitchen && {
            status: 'ACCEPTED',
            readyAt: null,
            servedAt: null,
          }),
        },
        include: ORDER_INCLUDE,
      });
      return { order: updated, added: true };
    });

    if (result.added) {
      const order = result.order;
      await this.realtime.emit({
        restaurantId,
        orderId,
        type: RealtimeEvents.OrderItemsAdded,
        payload: order,
        customerPayload: this.toCustomerView(order),
      });
    }
    return result.order;
  }

  // ───────────────────────── Workflow ─────────────────────────

  /**
   * Change le statut d'une commande (CMD-02, CMD-08).
   * Le client ne peut qu'annuler une commande encore en attente ; le staff
   * doit motiver une annulation ou un refus.
   */
  async transition(
    restaurantId: string,
    orderId: string,
    to: OrderStatus,
    options: { by: OrderSource; reason?: string; actor?: Actor },
  ): Promise<OrderWithItems> {
    const now = new Date();
    const { order, from, tableUpdated } = await this.prisma.$transaction(
      async (tx) => {
        const current = await lockOrder(tx, restaurantId, orderId);
        const from = current.status;

        if (
          options.by === 'CUSTOMER' &&
          (to !== 'CANCELLED' || from !== 'PENDING')
        ) {
          throw new ConflictException({
            code: 'CANNOT_CANCEL',
            message:
              'La commande a déjà été prise en charge : adressez-vous au personnel',
          });
        }
        if (!canTransition(from, to)) {
          throw new ConflictException({
            code: 'INVALID_TRANSITION',
            message: `Transition impossible : ${from} → ${to}`,
            details: { from, to },
          });
        }
        if (
          options.by === 'STAFF' &&
          REASON_REQUIRED.includes(to) &&
          !options.reason
        ) {
          throw new BadRequestException({
            code: 'REASON_REQUIRED',
            message: 'Un motif est obligatoire pour annuler ou refuser',
          });
        }

        const stamp = timestampFor(to);
        const isCancel = REASON_REQUIRED.includes(to);
        const updated = await tx.order.update({
          where: { id: orderId },
          data: {
            status: to,
            ...(stamp && { [stamp]: now }),
            ...(isCancel && {
              cancelReason: options.reason ?? 'Annulée par le client',
              cancelledBy: options.by,
            }),
          },
          include: ORDER_INCLUDE,
        });

        if (isCancel && STOCK_RESTORABLE_FROM.includes(from)) {
          await restoreStock(tx, current.items);
        }
        // Annulation ou refus : le code promo utilisé redevient disponible.
        if (isCancel) {
          await this.promotions.release(tx, orderId);
        }

        // Dernière commande de la table terminée : table « à nettoyer ».
        let tableUpdated = false;
        if (to === 'COMPLETED' && current.tableId) {
          const others = await tx.order.count({
            where: {
              tableId: current.tableId,
              id: { not: orderId },
              status: { in: ACTIVE_STATUSES },
            },
          });
          if (!others) {
            await tx.diningTable.update({
              where: { id: current.tableId },
              data: { status: 'TO_CLEAN', statusChangedAt: now },
            });
            tableUpdated = true;
          }
        }
        return { order: updated, from, tableUpdated };
      },
    );

    if (options.by === 'STAFF' && REASON_REQUIRED.includes(to)) {
      await this.audit.log({
        action: to === 'CANCELLED' ? 'orders.cancel' : 'orders.reject',
        entity: 'Order',
        entityId: orderId,
        restaurantId,
        actorId: options.actor?.id,
        before: { status: from },
        after: { status: to, reason: options.reason, total: order.total },
        ip: options.actor?.ip,
        userAgent: options.actor?.userAgent,
      });
    }

    await this.realtime.emit({
      restaurantId,
      orderId,
      type: RealtimeEvents.OrderStatusChanged,
      payload: { ...order, previousStatus: from },
      customerPayload: this.toCustomerView(order),
    });
    if (tableUpdated && order.tableId) {
      await this.emitTable(restaurantId, order.tableId);
    }
    return order;
  }

  // ───────────────────────── Lecture ─────────────────────────

  async list(restaurantId: string, query: ListOrdersQueryDto) {
    const where = this.buildWhere(restaurantId, query);
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          table: { select: { id: true, label: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: query.order },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(orders, total, query);
  }

  /** Commandes en cours, par ancienneté (écran cuisine / salle). */
  active(restaurantId: string) {
    return this.prisma.order.findMany({
      where: { restaurantId, status: { in: ACTIVE_STATUSES } },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(restaurantId: string, id: string): Promise<OrderWithItems> {
    const order = await this.prisma.order.findFirst({
      where: { id, restaurantId },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new NotFoundException('Commande introuvable');
    }
    return order;
  }

  /** Lecture par le client : l'identifiant seul ne suffit pas, il faut le jeton. */
  async findForCustomer(orderId: string): Promise<OrderWithItems> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new NotFoundException('Commande introuvable');
    }
    return order;
  }

  /** Événements de la commande (repli par polling côté client). */
  async customerEvents(orderId: string, afterSeq: number) {
    const events = await this.prisma.realtimeEvent.findMany({
      where: {
        orderId,
        seq: { gt: afterSeq },
        type: {
          in: [
            RealtimeEvents.OrderStatusChanged,
            RealtimeEvents.OrderItemsAdded,
          ],
        },
      },
      orderBy: { seq: 'asc' },
      take: 100,
      select: { seq: true, type: true, createdAt: true },
    });
    const order = await this.findForCustomer(orderId);
    return { events, order: this.toCustomerView(order) };
  }

  /** Export CSV de l'historique filtré (CMD-03). Montants en plus petite unité. */
  async exportCsv(restaurantId: string, query: ListOrdersQueryDto) {
    const orders = await this.prisma.order.findMany({
      where: this.buildWhere(restaurantId, query),
      include: { table: { select: { label: true } } },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
    });
    const header = [
      'numero',
      'date',
      'mode',
      'table',
      'statut',
      'paiement',
      'client',
      'sous_total',
      'remise',
      'taxes',
      'frais_service',
      'pourboire',
      'total',
      'devise',
    ];
    const rows = orders.map((o) => [
      o.number,
      o.createdAt.toISOString(),
      o.mode,
      o.table?.label ?? '',
      o.status,
      o.paymentStatus,
      o.customerName ?? '',
      o.subtotal,
      o.discountTotal,
      o.taxTotal,
      o.serviceFee,
      o.tipAmount,
      o.total,
      o.currency,
    ]);
    return toCsv([header, ...rows]);
  }

  /** Vue client : pas d'informations internes (créateur, clé d'idempotence…). */
  toCustomerView(order: OrderWithItems) {
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      mode: order.mode,
      table: order.table ? { label: order.table.label } : null,
      items: order.items.map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        options: (
          i.options as { groupName: string; name: string; priceDelta: number }[]
        ).map(({ groupName, name, priceDelta }) => ({
          groupName,
          name,
          priceDelta,
        })),
        notes: i.notes,
        lineTotal: i.lineTotal,
        batch: i.batch,
      })),
      currency: order.currency,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      promoCode: order.promoCode,
      taxTotal: order.taxTotal,
      serviceFee: order.serviceFee,
      tipAmount: order.tipAmount,
      total: order.total,
      paymentStatus: order.paymentStatus,
      estimatedReadyAt: order.estimatedReadyAt,
      cancelReason: order.cancelReason,
      createdAt: order.createdAt,
    };
  }

  // ───────────────────────── Utilitaires ─────────────────────────

  private findByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    return this.prisma.order.findUnique({
      where: { restaurantId_idempotencyKey: { restaurantId, idempotencyKey } },
      include: ORDER_INCLUDE,
    });
  }

  private async assertTable(restaurantId: string, tableId: string) {
    const table = await this.prisma.diningTable.findFirst({
      where: { id: tableId, restaurantId, deletedAt: null },
      select: { id: true },
    });
    if (!table) {
      throw new BadRequestException({
        code: 'INVALID_TABLE',
        message: 'Table introuvable',
      });
    }
  }

  /** Articles commandables : actifs, non supprimés, dans une catégorie active. */
  private async loadMenuItems(
    restaurantId: string,
    lines: OrderLineDto[],
  ): Promise<Map<string, OrderableMenuItem>> {
    const items = await this.prisma.menuItem.findMany({
      where: {
        id: { in: [...new Set(lines.map((l) => l.menuItemId))] },
        restaurantId,
        deletedAt: null,
        isActive: true,
        category: { deletedAt: null, isActive: true },
      },
      include: {
        optionGroups: {
          orderBy: { position: 'asc' },
          include: { options: { orderBy: { position: 'asc' } } },
        },
        category: { select: { stationId: true } },
      },
    });
    // Routage cuisine (KDS-02) : le poste de l'article prime sur celui de sa catégorie.
    return new Map(
      items.map((i) => [
        i.id,
        { ...i, stationId: i.stationId ?? i.category.stationId },
      ]),
    );
  }

  /**
   * Estimation du temps d'attente (CMD-15) : plat le plus long, majoré de
   * 2 min par commande déjà en cuisine (plafonné à 45 min).
   */
  private async estimateReadyAt(restaurantId: string, lines: BuiltLine[]) {
    const longest = Math.max(
      ...lines.map((l) => l.prepTimeMinutes ?? DEFAULT_PREP_MINUTES),
    );
    const queue = await this.prisma.order.count({
      where: {
        restaurantId,
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING'] },
      },
    });
    const minutes = longest + Math.min(queue * 2, 45);
    return new Date(Date.now() + minutes * 60_000);
  }

  private buildWhere(
    restaurantId: string,
    q: ListOrdersQueryDto,
  ): Prisma.OrderWhereInput {
    const searchNumber =
      q.search && /^\d+$/.test(q.search) ? Number(q.search) : null;
    return {
      restaurantId,
      ...(q.status?.length && { status: { in: q.status } }),
      ...(q.mode && { mode: q.mode }),
      ...(q.source && { source: q.source }),
      ...(q.paymentStatus && { paymentStatus: q.paymentStatus }),
      ...(q.tableId && { tableId: q.tableId }),
      ...((q.from || q.to) && {
        createdAt: {
          ...(q.from && { gte: new Date(q.from) }),
          ...(q.to && { lte: new Date(q.to) }),
        },
      }),
      ...((q.minTotal !== undefined || q.maxTotal !== undefined) && {
        total: {
          ...(q.minTotal !== undefined && { gte: q.minTotal }),
          ...(q.maxTotal !== undefined && { lte: q.maxTotal }),
        },
      }),
      ...(q.search && {
        OR: [
          ...(searchNumber !== null ? [{ number: searchNumber }] : []),
          { customerName: { contains: q.search } },
          { customerPhone: { contains: q.search } },
        ],
      }),
    };
  }

  private async emitTable(restaurantId: string, tableId: string) {
    const table = await this.prisma.diningTable.findUnique({
      where: { id: tableId },
      select: { id: true, label: true, status: true, statusChangedAt: true },
    });
    if (table) {
      await this.realtime.emit({
        restaurantId,
        type: RealtimeEvents.TableUpdated,
        payload: table,
      });
    }
  }
}

// ───────────────────────── Fonctions internes ─────────────────────────

function toItemInput(
  line: BuiltLine,
  position: number,
  batch: number,
  batchKey?: string,
) {
  return {
    position,
    menuItemId: line.menuItemId,
    name: line.name,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    options: line.options as unknown as Prisma.InputJsonValue,
    notes: line.notes,
    lineTotal: line.lineTotal,
    stationId: line.stationId,
    batch,
    batchKey,
  };
}

/** Verrouille la commande pour sérialiser les modifications concurrentes. */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  orderId: string,
): Promise<OrderWithItems> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
  const order = await tx.order.findFirst({
    where: { id: orderId, restaurantId },
    include: ORDER_INCLUDE,
  });
  if (!order) {
    throw new NotFoundException('Commande introuvable');
  }
  return order;
}

/** Décrément atomique : échoue si le stock a été consommé entre-temps. */
async function decrementStock(
  tx: Prisma.TransactionClient,
  stockNeeded: Map<string, number>,
) {
  for (const [id, qty] of stockNeeded) {
    const res = await tx.menuItem.updateMany({
      where: { id, stockQuantity: { gte: qty } },
      data: { stockQuantity: { decrement: qty } },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'OUT_OF_STOCK',
        message: 'Stock insuffisant pour un article du panier',
        details: { menuItemId: id },
      });
    }
  }
}

async function restoreStock(
  tx: Prisma.TransactionClient,
  items: { menuItemId: string; quantity: number }[],
) {
  const totals = new Map<string, number>();
  for (const i of items) {
    totals.set(i.menuItemId, (totals.get(i.menuItemId) ?? 0) + i.quantity);
  }
  for (const [id, qty] of totals) {
    await tx.menuItem.updateMany({
      where: { id, stockQuantity: { not: null } },
      data: { stockQuantity: { increment: qty } },
    });
  }
}

function isUniqueViolation(err: unknown, field: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    JSON.stringify(err.meta?.target ?? '').includes(field)
  );
}
