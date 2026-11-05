import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { STRIPE_CLIENT, toGatewayStatus } from './gateways/stripe.gateway';
import { PaymentsService } from './payments.service';

const PAYMENT_INTENT_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
];

/**
 * Webhooks Stripe (PAY-08) : signature vérifiée, chaque événement n'est
 * appliqué qu'une fois, et une erreur renvoie 500 pour que Stripe réessaie.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly webhookSecret?: string;

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.webhookSecret =
      config.get<string>('STRIPE_WEBHOOK_SECRET') || undefined;
  }

  async handle(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!this.stripe || !this.webhookSecret) {
      throw new ServiceUnavailableException('Stripe non configuré');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody ?? Buffer.alloc(0),
        signature ?? '',
        this.webhookSecret,
      );
    } catch {
      throw new BadRequestException({
        code: 'INVALID_SIGNATURE',
        message: 'Signature de webhook invalide',
      });
    }

    const record = await this.claim(event);
    if (!record) return { received: true, duplicate: true };

    try {
      await this.dispatch(event);
      await this.prisma.paymentWebhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date(), error: null },
      });
    } catch (err) {
      this.logger.error(err);
      await this.prisma.paymentWebhookEvent.update({
        where: { id: record.id },
        data: { error: String(err).slice(0, 500) },
      });
      throw err;
    }
    return { received: true };
  }

  /** Enregistre l'événement ; renvoie null s'il a déjà été traité. */
  private async claim(event: Stripe.Event) {
    try {
      return await this.prisma.paymentWebhookEvent.create({
        data: {
          provider: 'STRIPE',
          eventId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing =
          await this.prisma.paymentWebhookEvent.findUniqueOrThrow({
            where: {
              provider_eventId: { provider: 'STRIPE', eventId: event.id },
            },
          });
        // Déjà reçu mais en échec : on le retraite.
        return existing.processedAt ? null : existing;
      }
      throw err;
    }
  }

  private async dispatch(event: Stripe.Event) {
    if (PAYMENT_INTENT_EVENTS.includes(event.type)) {
      const intent = event.data.object as Stripe.PaymentIntent;
      const payment = await this.payments.findByProviderRef(
        'STRIPE',
        intent.id,
      );
      if (!payment) {
        this.logger.warn(`PaymentIntent inconnu : ${intent.id}`);
        return;
      }
      await this.payments.applyGatewayStatus(
        payment.id,
        toGatewayStatus(intent),
      );
      return;
    }
    if (event.type === 'account.updated') {
      const account = event.data.object;
      await this.prisma.restaurant.updateMany({
        where: { stripeAccountId: account.id },
        data: { stripeChargesEnabled: account.charges_enabled === true },
      });
    }
  }

  // ───────────────────── Stripe Connect (PAY-02) ─────────────────────

  /** Lien d'onboarding Stripe Express du restaurant (crée le compte au besoin). */
  async onboardingLink(
    restaurantId: string,
    returnUrl: string,
    refreshUrl: string,
  ) {
    if (!this.stripe) {
      throw new ServiceUnavailableException({
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        message: 'Le paiement par carte n’est pas configuré sur la plateforme',
      });
    }
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });
    let accountId = restaurant.stripeAccountId;
    if (!accountId) {
      const account = await this.stripe.accounts.create(
        {
          type: 'express',
          country: restaurant.country,
          email: restaurant.email ?? undefined,
          business_profile: { name: restaurant.name },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { restaurantId },
        },
        { idempotencyKey: `connect-account-${restaurantId}` },
      );
      accountId = account.id;
      const claimed = await this.prisma.restaurant.updateMany({
        where: { id: restaurantId, stripeAccountId: null },
        data: { stripeAccountId: accountId },
      });
      if (claimed.count === 0) {
        throw new ConflictException('Compte Stripe déjà en cours de création');
      }
    }
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async connectStatus(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { stripeAccountId: true, stripeChargesEnabled: true },
    });
    return {
      connected: !!restaurant.stripeAccountId,
      chargesEnabled: restaurant.stripeChargesEnabled,
    };
  }
}
