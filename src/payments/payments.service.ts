import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/types/request-context';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { lockOrder, OrderWithItems } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvents } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CashPaymentDto,
  OnlinePaymentDto,
  RefundDto,
} from './dto/payments.dto';
import { GatewayStatus, PaymentGateway } from './gateways/payment-gateway';
import { SandboxGateway } from './gateways/sandbox.gateway';
import { StripeGateway } from './gateways/stripe.gateway';
import { amountDue, computePaymentStatus } from './payment-status';

const UNPAYABLE_STATUSES = ['CANCELLED', 'REJECTED'];
/** Rapprochement : vérification après 10 min, abandon après 24 h. */
const RECONCILE_AFTER_MS = 10 * 60_000;
const ABANDON_AFTER_MS = 24 * 3_600_000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly commissionBp: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly sandbox: SandboxGateway,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly loyalty: LoyaltyService,
    config: ConfigService,
  ) {
    this.commissionBp = config.get<number>('PLATFORM_COMMISSION_BP') ?? 0;
  }

  // ───────────────────────── Espèces (PAY-05) ─────────────────────────

  async recordCash(
    restaurantId: string,
    orderId: string,
    dto: CashPaymentDto,
    idempotencyKey: string,
    actor: Actor,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, restaurantId, orderId);
      const replay = await tx.payment.findUnique({
        where: {
          restaurantId_idempotencyKey: { restaurantId, idempotencyKey },
        },
      });
      if (replay) return { payment: replay, change: 0, replayed: true };

      const amount = await this.payableAmount(tx, order, dto.amount);
      if (dto.amountReceived !== undefined && dto.amountReceived < amount) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_CASH',
          message: 'La somme remise est inférieure au montant à encaisser',
        });
      }
      const payment = await tx.payment.create({
        data: {
          restaurantId,
          orderId,
          provider: 'CASH',
          method: 'CASH',
          status: 'SUCCEEDED',
          amount,
          currency: order.currency,
          idempotencyKey,
          collectedById: actor.id,
          succeededAt: new Date(),
        },
      });
      await this.syncOrderPaymentStatus(tx, orderId);
      return {
        payment,
        change: (dto.amountReceived ?? amount) - amount,
        replayed: false,
      };
    });

    if (!result.replayed) {
      await this.audit.log({
        action: 'payments.cash_collected',
        entity: 'Payment',
        entityId: result.payment.id,
        restaurantId,
        actorId: actor.id,
        after: { orderId, amount: result.payment.amount },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      await this.emitPaymentUpdate(orderId);
    }
    return { payment: result.payment, change: result.change };
  }

  // ───────────────────── Paiement en ligne (PAY-01/04/06) ─────────────────────

  /**
   * Initie un paiement par carte ou mobile money. Le statut définitif arrive
   * de façon asynchrone (webhook, notification opérateur ou rapprochement) :
   * il n'est jamais déduit d'un retour du navigateur client.
   */
  async initiateOnline(
    orderId: string,
    dto: OnlinePaymentDto,
    idempotencyKey: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: {
          select: {
            name: true,
            stripeAccountId: true,
            stripeChargesEnabled: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable');

    const gateway = this.gatewayFor(dto.method);
    const restaurantId = order.restaurantId;
    const destination =
      gateway.provider === 'STRIPE'
        ? this.stripeDestination(order.restaurant)
        : null;

    const prepared = await this.prisma.$transaction(async (tx) => {
      const locked = await lockOrder(tx, restaurantId, orderId);
      const replay = await tx.payment.findUnique({
        where: {
          restaurantId_idempotencyKey: { restaurantId, idempotencyKey },
        },
      });
      if (replay) return { payment: replay, replayed: true, superseded: [] };

      const amount = await this.payableAmount(tx, locked, dto.amount);
      // Une nouvelle tentative remplace les tentatives en ligne abandonnées.
      const superseded = await tx.payment.findMany({
        where: { orderId, status: 'PENDING', provider: { not: 'CASH' } },
      });
      if (superseded.length) {
        await tx.payment.updateMany({
          where: { id: { in: superseded.map((p) => p.id) } },
          data: {
            status: 'CANCELLED',
            failureReason: 'Remplacé par une nouvelle tentative',
          },
        });
      }
      const payment = await tx.payment.create({
        data: {
          restaurantId,
          orderId,
          provider: gateway.provider,
          method: dto.method,
          amount,
          currency: locked.currency,
          applicationFee: Math.round((amount * this.commissionBp) / 10_000),
          operator: dto.operator,
          payerPhone: dto.payerPhone,
          idempotencyKey,
        },
      });
      await this.syncOrderPaymentStatus(tx, orderId);
      return { payment, replayed: false, superseded };
    });

    for (const old of prepared.superseded) {
      if (old.providerRef) {
        await this.gatewayByProvider(old.provider).cancel(old.providerRef);
      }
    }

    let { payment } = prepared;
    // Rejeu : on renvoie les informations de paiement existantes.
    if (prepared.replayed && payment.providerRef) {
      const status = await gateway.retrieve(payment.providerRef);
      return this.toInitiation(
        payment,
        status.clientSecret,
        status.redirectUrl,
      );
    }

    try {
      const created = await gateway.create({
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        method: dto.method,
        operator: dto.operator,
        payerPhone: dto.payerPhone,
        applicationFee: payment.applicationFee,
        destinationAccount: destination,
        description: `${order.restaurant.name} — commande n°${order.number}`,
      });
      payment = await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerRef: created.providerRef },
      });
      await this.emitPaymentUpdate(orderId);
      return this.toInitiation(
        payment,
        created.clientSecret,
        created.redirectUrl,
      );
    } catch (err) {
      this.logger.error(err);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          failureReason: 'Erreur du fournisseur de paiement',
        },
      });
      await this.prisma.$transaction((tx) =>
        this.syncOrderPaymentStatus(tx, orderId),
      );
      throw new BadGatewayException({
        code: 'PAYMENT_PROVIDER_ERROR',
        message: 'Le fournisseur de paiement est indisponible, réessayez',
      });
    }
  }

  // ─────────────────── Rapprochement et webhooks (PAY-08) ───────────────────

  /**
   * Applique l'état réel d'un paiement côté fournisseur. Idempotent : un même
   * état appliqué deux fois ne produit qu'un seul effet. Un paiement n'est
   * validé que si le montant et la devise reçus correspondent.
   */
  async applyGatewayStatus(paymentId: string, state: GatewayStatus) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      await lockOrder(tx, current.restaurantId, current.orderId);
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      if (payment.status === state.status || payment.status === 'SUCCEEDED') {
        return { changed: false, anomaly: false, payment };
      }
      if (state.status === 'PENDING') {
        return { changed: false, anomaly: false, payment };
      }
      if (
        state.status === 'SUCCEEDED' &&
        (state.amount !== payment.amount ||
          state.currency.toUpperCase() !== payment.currency)
      ) {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            failureReason: `Montant reçu incohérent : ${state.amount} ${state.currency}`,
          },
        });
        return { changed: false, anomaly: true, payment };
      }

      // Un paiement remplacé puis confirmé tardivement reste encaissé.
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: state.status,
          failureReason:
            state.status === 'SUCCEEDED' ? null : state.failureReason,
          ...(state.status === 'SUCCEEDED' && { succeededAt: new Date() }),
        },
      });
      await this.syncOrderPaymentStatus(tx, payment.orderId);
      return { changed: true, anomaly: false, payment: updated };
    });

    if (outcome.anomaly) {
      await this.audit.log({
        action: 'payments.amount_mismatch',
        entity: 'Payment',
        entityId: paymentId,
        restaurantId: outcome.payment.restaurantId,
        before: { expected: outcome.payment.amount },
        after: { received: state.amount, currency: state.currency },
      });
    }
    if (outcome.changed) {
      await this.emitPaymentUpdate(outcome.payment.orderId);
    }
    return outcome.payment;
  }

  /** Interroge le fournisseur pour un paiement en attente (webhook manqué). */
  async reconcile(restaurantId: string, paymentId: string) {
    const payment = await this.getOrThrow(restaurantId, paymentId);
    if (payment.status !== 'PENDING' || !payment.providerRef) return payment;
    const state = await this.gatewayByProvider(payment.provider).retrieve(
      payment.providerRef,
    );
    return this.applyGatewayStatus(payment.id, state);
  }

  /**
   * Rapprochement automatique (tâche planifiée, PAY-08) : les paiements en
   * ligne en attente depuis plus de 10 min sont vérifiés auprès du
   * fournisseur ; au-delà de 24 h sans confirmation, la tentative est annulée.
   */
  async reconcileStale(now = new Date()) {
    const stale = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        provider: { not: 'CASH' },
        createdAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const summary = { checked: 0, settled: 0, expired: 0, errors: 0 };
    for (const payment of stale) {
      summary.checked++;
      try {
        if (payment.providerRef) {
          const updated = await this.reconcile(
            payment.restaurantId,
            payment.id,
          );
          if (updated.status !== 'PENDING') {
            summary.settled++;
            continue;
          }
        }
        if (now.getTime() - payment.createdAt.getTime() > ABANDON_AFTER_MS) {
          if (payment.providerRef) {
            await this.gatewayByProvider(payment.provider).cancel(
              payment.providerRef,
            );
          }
          await this.applyGatewayStatus(payment.id, {
            status: 'CANCELLED',
            amount: payment.amount,
            currency: payment.currency,
            failureReason: 'Paiement non confirmé sous 24 h',
          });
          summary.expired++;
        }
      } catch (err) {
        summary.errors++;
        this.logger.warn(
          `Rapprochement impossible pour ${payment.id} : ${String(err)}`,
        );
      }
    }
    return summary;
  }

  /** Paiement retrouvé par sa référence fournisseur (webhooks). */
  findByProviderRef(provider: PaymentProvider, providerRef: string) {
    return this.prisma.payment.findUnique({
      where: { provider_providerRef: { provider, providerRef } },
    });
  }

  /** Simulateur : notification de l'opérateur (dev / tests). */
  async simulateSandbox(
    paymentId: string,
    outcome: 'SUCCEEDED' | 'FAILED',
    amount?: number,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.provider !== 'SANDBOX' || !payment.providerRef) {
      throw new NotFoundException('Paiement introuvable');
    }
    const state: GatewayStatus = {
      status: outcome,
      amount: amount ?? payment.amount,
      currency: payment.currency,
      failureReason:
        outcome === 'FAILED' ? 'Refusé par l’opérateur' : undefined,
    };
    this.sandbox.simulate(payment.providerRef, state);
    return this.applyGatewayStatus(payment.id, state);
  }

  // ───────────────────────── Remboursements (PAY-07) ─────────────────────────

  async refund(
    restaurantId: string,
    paymentId: string,
    dto: RefundDto,
    actor: Actor,
  ) {
    // 1. Réserve le montant sous verrou, pour empêcher deux remboursements simultanés de dépasser le paiement.
    const { payment, refund } = await this.prisma.$transaction(async (tx) => {
      const found = await this.getOrThrow(restaurantId, paymentId, tx);
      await lockOrder(tx, restaurantId, found.orderId);
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      if (payment.status !== 'SUCCEEDED') {
        throw new ConflictException({
          code: 'PAYMENT_NOT_REFUNDABLE',
          message: 'Seul un paiement encaissé peut être remboursé',
        });
      }
      const refundable = payment.amount - payment.refundedAmount;
      const amount = dto.amount ?? refundable;
      if (amount <= 0 || amount > refundable) {
        throw new BadRequestException({
          code: 'REFUND_EXCEEDS_PAYMENT',
          message: `Montant remboursable maximum : ${refundable}`,
          details: { refundable },
        });
      }
      await tx.payment.update({
        where: { id: paymentId },
        data: { refundedAmount: { increment: amount } },
      });
      const refund = await tx.refund.create({
        data: {
          paymentId,
          restaurantId,
          amount,
          reason: dto.reason,
          createdById: actor.id,
          status: payment.provider === 'CASH' ? 'SUCCEEDED' : 'PENDING',
        },
      });
      return { payment, refund };
    });

    // 2. Appel au fournisseur (hors transaction) ; en cas d'échec, on libère la réserve.
    let finalRefund = refund;
    if (payment.provider !== 'CASH' && payment.providerRef) {
      try {
        const result = await this.gatewayByProvider(payment.provider).refund(
          payment.providerRef,
          refund.amount,
        );
        finalRefund = await this.prisma.refund.update({
          where: { id: refund.id },
          data: { status: result.status, providerRef: result.providerRef },
        });
        if (result.status === 'FAILED') throw new Error('Remboursement refusé');
      } catch (err) {
        this.logger.error(err);
        await this.prisma.$transaction([
          this.prisma.refund.update({
            where: { id: refund.id },
            data: { status: 'FAILED' },
          }),
          this.prisma.payment.update({
            where: { id: paymentId },
            data: { refundedAmount: { decrement: refund.amount } },
          }),
        ]);
        throw new BadGatewayException({
          code: 'REFUND_FAILED',
          message: 'Le remboursement a été refusé par le fournisseur',
        });
      }
    }

    await this.prisma.$transaction((tx) =>
      this.syncOrderPaymentStatus(tx, payment.orderId),
    );
    await this.audit.log({
      action: 'payments.refund',
      entity: 'Refund',
      entityId: finalRefund.id,
      restaurantId,
      actorId: actor.id,
      after: {
        paymentId,
        orderId: payment.orderId,
        amount: finalRefund.amount,
        reason: dto.reason,
        status: finalRefund.status,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    await this.emitPaymentUpdate(payment.orderId);
    return finalRefund;
  }

  // ───────────────────────── Lecture ─────────────────────────

  listForOrder(restaurantId: string, orderId: string) {
    return this.prisma.payment.findMany({
      where: { restaurantId, orderId },
      include: { refunds: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Statut de paiement d'une commande, pour le client. */
  async customerSummary(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payments: { orderBy: { createdAt: 'asc' } } },
    });
    return {
      paymentStatus: order.paymentStatus,
      total: order.total,
      amountDue: amountDue(order.total, order.payments),
      currency: order.currency,
      payments: order.payments.map((p) => ({
        id: p.id,
        method: p.method,
        status: p.status,
        amount: p.amount,
        refundedAmount: p.refundedAmount,
        createdAt: p.createdAt,
      })),
    };
  }

  /** Reçu numérique (PAY-09) ; numéro séquentiel attribué au premier paiement complet. */
  async receipt(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { orderBy: [{ batch: 'asc' }, { position: 'asc' }] },
        table: { select: { label: true } },
        restaurant: {
          select: {
            name: true,
            address: true,
            city: true,
            phone: true,
            email: true,
            taxEnabled: true,
          },
        },
        payments: {
          where: { status: 'SUCCEEDED' },
          include: { refunds: { where: { status: { not: 'FAILED' } } } },
          orderBy: { succeededAt: 'asc' },
        },
      },
    });
    if (order.receiptNumber === null) {
      throw new ConflictException({
        code: 'RECEIPT_NOT_AVAILABLE',
        message:
          'Le reçu est disponible une fois la commande entièrement réglée',
      });
    }
    return {
      receiptNumber: `R-${String(order.receiptNumber).padStart(6, '0')}`,
      issuedAt: order.paidAt,
      restaurant: order.restaurant,
      order: {
        number: order.number,
        mode: order.mode,
        table: order.table?.label ?? null,
        createdAt: order.createdAt,
      },
      items: order.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        options: (i.options as { name: string }[]).map((o) => o.name),
        lineTotal: i.lineTotal,
      })),
      currency: order.currency,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      taxTotal: order.taxTotal,
      taxRateBp: order.taxRateBp,
      pricesIncludeTax: order.pricesIncludeTax,
      serviceFee: order.serviceFee,
      tipAmount: order.tipAmount,
      total: order.total,
      payments: order.payments.map((p) => ({
        method: p.method,
        operator: p.operator,
        amount: p.amount,
        paidAt: p.succeededAt,
        refunds: p.refunds.map((r) => ({
          amount: r.amount,
          reason: r.reason,
          date: r.createdAt,
        })),
      })),
    };
  }

  // ───────────────────────── Utilitaires ─────────────────────────

  /**
   * Recalcule le statut de paiement de la commande. Au premier règlement
   * complet, attribue un numéro de reçu séquentiel sans trou (PAY-09).
   */
  async syncOrderPaymentStatus(tx: Prisma.TransactionClient, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payments: true },
    });
    const paymentStatus = computePaymentStatus(order.total, order.payments);
    const data: Prisma.OrderUpdateInput = { paymentStatus };
    if (paymentStatus === 'PAID' && order.receiptNumber === null) {
      const { receiptSeq } = await tx.restaurant.update({
        where: { id: order.restaurantId },
        data: { receiptSeq: { increment: 1 } },
        select: { receiptSeq: true },
      });
      data.receiptNumber = receiptSeq;
      data.paidAt = new Date();
    }
    await tx.order.update({ where: { id: orderId }, data });

    // Fidélité (CLI-02) : crédit au premier règlement complet, reprise si tout est remboursé.
    if (paymentStatus === 'PAID') {
      await this.loyalty.onOrderPaid(tx, orderId);
    } else if (paymentStatus === 'REFUNDED') {
      await this.loyalty.onOrderRefunded(tx, orderId);
    }
  }

  private async payableAmount(
    tx: Prisma.TransactionClient,
    order: OrderWithItems,
    requested?: number,
  ): Promise<number> {
    if (UNPAYABLE_STATUSES.includes(order.status)) {
      throw new ConflictException({
        code: 'ORDER_NOT_PAYABLE',
        message: 'Une commande annulée ou refusée ne peut pas être réglée',
      });
    }
    const payments = await tx.payment.findMany({
      where: { orderId: order.id },
    });
    const due = amountDue(order.total, payments);
    if (due === 0) {
      throw new ConflictException({
        code: 'ORDER_ALREADY_PAID',
        message: 'Cette commande est déjà réglée',
      });
    }
    const amount = requested ?? due;
    if (amount > due) {
      throw new BadRequestException({
        code: 'AMOUNT_EXCEEDS_DUE',
        message: `Le montant dépasse le reste à payer (${due})`,
        details: { amountDue: due },
      });
    }
    return amount;
  }

  private gatewayFor(method: PaymentMethod): PaymentGateway {
    const candidates: PaymentGateway[] = [this.stripe, this.sandbox];
    const gateway = candidates.find((g) => g.isEnabled() && g.supports(method));
    if (!gateway) {
      throw new ServiceUnavailableException({
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        message: 'Ce moyen de paiement n’est pas disponible pour le moment',
      });
    }
    return gateway;
  }

  private gatewayByProvider(provider: PaymentProvider): PaymentGateway {
    if (provider === 'STRIPE') return this.stripe;
    if (provider === 'SANDBOX') return this.sandbox;
    throw new Error(`Aucune passerelle pour ${provider}`);
  }

  /** Paiement par carte : les fonds doivent aller au compte connecté du restaurant. */
  private stripeDestination(restaurant: {
    stripeAccountId: string | null;
    stripeChargesEnabled: boolean;
  }): string {
    if (!restaurant.stripeAccountId || !restaurant.stripeChargesEnabled) {
      throw new ConflictException({
        code: 'STRIPE_NOT_CONNECTED',
        message:
          "Le paiement par carte n'est pas encore activé pour cet établissement",
      });
    }
    return restaurant.stripeAccountId;
  }

  private async getOrThrow(
    restaurantId: string,
    paymentId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, restaurantId },
    });
    if (!payment) throw new NotFoundException('Paiement introuvable');
    return payment;
  }

  private toInitiation(
    payment: Payment,
    clientSecret?: string,
    redirectUrl?: string,
  ) {
    return {
      paymentId: payment.id,
      provider: payment.provider,
      method: payment.method,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      clientSecret,
      redirectUrl,
    };
  }

  private async emitPaymentUpdate(orderId: string) {
    const summary = await this.customerSummary(orderId);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { restaurantId: true, number: true },
    });
    await this.realtime.emit({
      restaurantId: order.restaurantId,
      orderId,
      type: RealtimeEvents.OrderPaymentUpdated,
      payload: { orderId, number: order.number, ...summary },
      customerPayload: { orderId, ...summary },
    });
  }
}
