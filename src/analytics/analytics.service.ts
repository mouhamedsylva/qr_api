import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { toCsv } from '../common/utils/csv.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  localDateKey,
  localDaysBetween,
  localHour,
  percentChange,
  previousPeriod,
} from './analytics.util';
import type { AnalyticsQueryDto } from './dto/analytics.dto';

const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 366;
const EXCLUDED: OrderStatus[] = ['CANCELLED', 'REJECTED'];
/** Commandes encaissées, base du rapport fiscal (ANA-07). */
const SETTLED: PaymentStatus[] = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];

interface Period {
  from: Date;
  to: Date;
  timeZone: string;
  currency: string;
}

type OrderRow = Prisma.OrderGetPayload<{
  select: {
    createdAt: true;
    total: true;
    status: true;
    mode: true;
    source: true;
  };
}>;

/**
 * Analytics de l'établissement (module 12). Les montants sont dans la plus
 * petite unité de la devise ; les regroupements par jour et par heure suivent
 * le fuseau horaire de l'établissement.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────── Tableau de bord (ANA-01) ─────────────────────

  async overview(restaurantId: string, query: AnalyticsQueryDto) {
    const period = await this.period(restaurantId, query);
    const previous = previousPeriod(period.from, period.to);
    const [orders, previousOrders] = await Promise.all([
      this.loadOrders(restaurantId, period.from, period.to),
      this.loadOrders(restaurantId, previous.from, previous.to),
    ]);
    const current = summarize(orders);
    const before = summarize(previousOrders);

    const daily = new Map(
      localDaysBetween(period.from, period.to, period.timeZone).map((d) => [
        d,
        { date: d, orders: 0, revenue: 0 },
      ]),
    );
    const peakHours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      orders: 0,
      revenue: 0,
    }));
    const byMode: Record<string, { orders: number; revenue: number }> = {};
    const bySource: Record<string, { orders: number; revenue: number }> = {};

    for (const o of orders.filter((o) => !EXCLUDED.includes(o.status))) {
      const day = daily.get(localDateKey(o.createdAt, period.timeZone));
      if (day) {
        day.orders++;
        day.revenue += o.total;
      }
      const hour = peakHours[localHour(o.createdAt, period.timeZone)];
      hour.orders++;
      hour.revenue += o.total;
      for (const [bucket, key] of [
        [byMode, o.mode],
        [bySource, o.source],
      ] as const) {
        bucket[key] ??= { orders: 0, revenue: 0 };
        bucket[key].orders++;
        bucket[key].revenue += o.total;
      }
    }

    return {
      period: { from: period.from, to: period.to, timeZone: period.timeZone },
      currency: period.currency,
      ...current,
      comparison: {
        previousPeriod: previous,
        revenue: before.revenue,
        orders: before.orders,
        averageBasket: before.averageBasket,
        revenueChange: percentChange(current.revenue, before.revenue),
        ordersChange: percentChange(current.orders, before.orders),
        averageBasketChange: percentChange(
          current.averageBasket,
          before.averageBasket,
        ),
      },
      byMode,
      bySource,
      peakHours,
      daily: [...daily.values()],
    };
  }

  async overviewCsv(restaurantId: string, query: AnalyticsQueryDto) {
    const data = await this.overview(restaurantId, query);
    return toCsv([
      ['date', 'commandes', 'chiffre_affaires', 'devise'],
      ...data.daily.map((d) => [d.date, d.orders, d.revenue, data.currency]),
    ]);
  }

  // ───────────────────── Performance du menu (ANA-02) ─────────────────────

  /**
   * Ventes par article : quantités, chiffre d'affaires et marge (si le coût
   * de revient est renseigné). Le coût ne couvre que le plat de base ; les
   * suppléments sont comptés dans le chiffre d'affaires.
   */
  async menuPerformance(restaurantId: string, query: AnalyticsQueryDto) {
    const period = await this.period(restaurantId, query);
    const sales = await this.prisma.orderItem.groupBy({
      by: ['menuItemId'],
      where: {
        order: {
          restaurantId,
          createdAt: { gte: period.from, lt: period.to },
          status: { notIn: EXCLUDED },
        },
      },
      _sum: { quantity: true, lineTotal: true },
    });
    const soldIds = sales.map((s) => s.menuItemId);
    const items = await this.prisma.menuItem.findMany({
      where: {
        restaurantId,
        OR: [{ id: { in: soldIds } }, { deletedAt: null, isActive: true }],
      },
      select: {
        id: true,
        name: true,
        priceAmount: true,
        costAmount: true,
        isActive: true,
        deletedAt: true,
        category: { select: { name: true } },
      },
    });
    const byId = new Map(sales.map((s) => [s.menuItemId, s._sum]));
    const rows = items.map((item) => {
      const quantity = byId.get(item.id)?.quantity ?? 0;
      const revenue = byId.get(item.id)?.lineTotal ?? 0;
      const cost = item.costAmount === null ? null : item.costAmount * quantity;
      const margin = cost === null ? null : revenue - cost;
      return {
        menuItemId: item.id,
        name: item.name,
        category: item.category.name,
        active: item.isActive && !item.deletedAt,
        quantity,
        revenue,
        cost,
        margin,
        marginRate:
          margin === null || revenue === 0
            ? null
            : Math.round((margin / revenue) * 1000) / 10,
      };
    });
    rows.sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity);

    const active = rows.filter((r) => r.active);
    return {
      period: { from: period.from, to: period.to },
      currency: period.currency,
      items: rows,
      bestSellers: [...rows]
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10),
      leastSold: [...active]
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 10),
      lowestMargin: rows
        .filter((r) => r.marginRate !== null && r.quantity > 0)
        .sort((a, b) => a.marginRate! - b.marginRate!)
        .slice(0, 10),
    };
  }

  async menuPerformanceCsv(restaurantId: string, query: AnalyticsQueryDto) {
    const data = await this.menuPerformance(restaurantId, query);
    return toCsv([
      [
        'article',
        'categorie',
        'quantite',
        'chiffre_affaires',
        'cout',
        'marge',
        'taux_marge_pct',
        'devise',
      ],
      ...data.items.map((r) => [
        r.name,
        r.category,
        r.quantity,
        r.revenue,
        r.cost,
        r.margin,
        r.marginRate,
        data.currency,
      ]),
    ]);
  }

  // ───────────────────── Rapport fiscal (ANA-07) ─────────────────────

  /**
   * Récapitulatif TVA des commandes encaissées, par date d'encaissement et
   * par taux. Base HT = montant net de remise, hors TVA, hors frais de
   * service et pourboire (déclarés à part).
   */
  async taxReport(restaurantId: string, query: AnalyticsQueryDto) {
    const period = await this.period(restaurantId, query);
    const groupBy = query.groupBy ?? 'day';
    const [orders, refunds] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          restaurantId,
          paymentStatus: { in: SETTLED },
          paidAt: { gte: period.from, lt: period.to },
        },
        select: {
          paidAt: true,
          subtotal: true,
          discountTotal: true,
          taxTotal: true,
          taxRateBp: true,
          pricesIncludeTax: true,
          serviceFee: true,
          tipAmount: true,
        },
      }),
      this.prisma.refund.aggregate({
        where: {
          restaurantId,
          status: { not: 'FAILED' },
          createdAt: { gte: period.from, lt: period.to },
        },
        _sum: { amount: true },
      }),
    ]);

    const lines = new Map<
      string,
      {
        period: string;
        taxRateBp: number;
        orders: number;
        baseAmount: number;
        taxAmount: number;
        totalInclTax: number;
        serviceFees: number;
        tips: number;
      }
    >();
    for (const o of orders) {
      const day = localDateKey(o.paidAt!, period.timeZone);
      const key = groupBy === 'month' ? day.slice(0, 7) : day;
      const id = `${key}|${o.taxRateBp}`;
      const net = o.subtotal - o.discountTotal;
      const base = o.pricesIncludeTax ? net - o.taxTotal : net;
      const line = lines.get(id) ?? {
        period: key,
        taxRateBp: o.taxRateBp,
        orders: 0,
        baseAmount: 0,
        taxAmount: 0,
        totalInclTax: 0,
        serviceFees: 0,
        tips: 0,
      };
      line.orders++;
      line.baseAmount += base;
      line.taxAmount += o.taxTotal;
      line.totalInclTax += base + o.taxTotal;
      line.serviceFees += o.serviceFee;
      line.tips += o.tipAmount;
      lines.set(id, line);
    }
    const rows = [...lines.values()].sort(
      (a, b) => a.period.localeCompare(b.period) || a.taxRateBp - b.taxRateBp,
    );
    const sum = (
      k: 'baseAmount' | 'taxAmount' | 'totalInclTax' | 'serviceFees' | 'tips',
    ) => rows.reduce((s, r) => s + r[k], 0);

    return {
      period: { from: period.from, to: period.to },
      currency: period.currency,
      groupBy,
      lines: rows,
      totals: {
        orders: orders.length,
        baseAmount: sum('baseAmount'),
        taxAmount: sum('taxAmount'),
        totalInclTax: sum('totalInclTax'),
        serviceFees: sum('serviceFees'),
        tips: sum('tips'),
        refunds: refunds._sum.amount ?? 0,
      },
    };
  }

  async taxReportCsv(restaurantId: string, query: AnalyticsQueryDto) {
    const data = await this.taxReport(restaurantId, query);
    return toCsv([
      [
        'periode',
        'taux_tva_pct',
        'commandes',
        'base_ht',
        'tva',
        'total_ttc',
        'frais_service',
        'pourboires',
        'devise',
      ],
      ...data.lines.map((l) => [
        l.period,
        l.taxRateBp / 100,
        l.orders,
        l.baseAmount,
        l.taxAmount,
        l.totalInclTax,
        l.serviceFees,
        l.tips,
        data.currency,
      ]),
    ]);
  }

  // ───────────────────── Interne ─────────────────────

  /** Période demandée (30 derniers jours par défaut, 366 jours maximum). */
  private async period(
    restaurantId: string,
    query: AnalyticsQueryDto,
  ): Promise<Period> {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timezone: true, currency: true },
    });
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) {
      throw new BadRequestException({
        code: 'INVALID_PERIOD',
        message: 'La date de début doit précéder la date de fin',
      });
    }
    if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
      throw new BadRequestException({
        code: 'PERIOD_TOO_LONG',
        message: `Période limitée à ${MAX_PERIOD_DAYS} jours`,
      });
    }
    return {
      from,
      to,
      timeZone: restaurant.timezone,
      currency: restaurant.currency,
    };
  }

  private loadOrders(restaurantId: string, from: Date, to: Date) {
    return this.prisma.order.findMany({
      where: { restaurantId, createdAt: { gte: from, lt: to } },
      select: {
        createdAt: true,
        total: true,
        status: true,
        mode: true,
        source: true,
      },
    });
  }
}

/** Indicateurs clés d'une liste de commandes. */
function summarize(orders: OrderRow[]) {
  const counted = orders.filter((o) => !EXCLUDED.includes(o.status));
  const revenue = counted.reduce((s, o) => s + o.total, 0);
  const cancelled = orders.length - counted.length;
  return {
    revenue,
    orders: counted.length,
    averageBasket: counted.length ? Math.round(revenue / counted.length) : 0,
    cancelledOrders: cancelled,
    cancellationRate: orders.length
      ? Math.round((cancelled / orders.length) * 1000) / 10
      : 0,
  };
}
