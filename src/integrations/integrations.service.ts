import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { localDateKey } from '../analytics/analytics.util';
import { toCsv } from '../common/utils/csv.util';
import { PrismaService } from '../prisma/prisma.service';

const MAX_EXPORT_DAYS = 366;

@Injectable()
export class IntegrationsService {
  private readonly clientUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.clientUrl = config
      .getOrThrow<string>('CLIENT_APP_URL')
      .replace(/\/+$/, '');
  }

  /**
   * Liens à publier sur Google Business, les réseaux sociaux ou un site
   * (INT-06) : menu en ligne et commande à emporter.
   */
  async links(restaurantId: string) {
    const { slug } = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { slug: true },
    });
    const menuUrl = `${this.clientUrl}/r/${slug}`;
    return {
      menuUrl,
      orderUrl: `${menuUrl}?mode=takeaway`,
      reviewsUrl: `${menuUrl}/avis`,
    };
  }

  /**
   * Export comptable (INT-04) : journal des ventes réglées (par date
   * d'encaissement, avec ventilation HT / TVA) et des remboursements, au
   * format CSV importable dans un tableur ou un logiciel comptable.
   */
  async accountingExport(restaurantId: string, fromIso: string, toIso: string) {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (
      from >= to ||
      to.getTime() - from.getTime() > MAX_EXPORT_DAYS * 86_400_000
    ) {
      throw new BadRequestException({
        code: 'INVALID_PERIOD',
        message: `Période invalide (${MAX_EXPORT_DAYS} jours maximum)`,
      });
    }
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    const [orders, refunds] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          restaurantId,
          paidAt: { gte: from, lt: to },
          receiptNumber: { not: null },
        },
        include: {
          payments: {
            where: { status: 'SUCCEEDED' },
            select: { method: true },
          },
        },
        orderBy: { receiptNumber: 'asc' },
      }),
      this.prisma.refund.findMany({
        where: {
          restaurantId,
          status: { not: 'FAILED' },
          createdAt: { gte: from, lt: to },
        },
        include: {
          payment: {
            select: {
              method: true,
              currency: true,
              order: { select: { number: true, receiptNumber: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const receipt = (n: number | null) =>
      n === null ? '' : `R-${String(n).padStart(6, '0')}`;
    const rows: (string | number | null)[][] = [
      [
        'date',
        'type',
        'piece',
        'commande',
        'montant_ht',
        'tva',
        'montant_ttc',
        'frais_service',
        'pourboire',
        'moyens_paiement',
        'devise',
        'motif',
      ],
    ];
    for (const o of orders) {
      const net = o.subtotal - o.discountTotal;
      const base = o.pricesIncludeTax ? net - o.taxTotal : net;
      rows.push([
        localDateKey(o.paidAt!, restaurant.timezone),
        'VENTE',
        receipt(o.receiptNumber),
        o.number,
        base,
        o.taxTotal,
        base + o.taxTotal,
        o.serviceFee,
        o.tipAmount,
        [...new Set(o.payments.map((p) => p.method))].join('+'),
        o.currency,
        null,
      ]);
    }
    for (const r of refunds) {
      rows.push([
        localDateKey(r.createdAt, restaurant.timezone),
        'REMBOURSEMENT',
        receipt(r.payment.order.receiptNumber),
        r.payment.order.number,
        null,
        null,
        -r.amount,
        null,
        null,
        r.payment.method,
        r.payment.currency,
        r.reason,
      ]);
    }
    return toCsv(rows);
  }
}
