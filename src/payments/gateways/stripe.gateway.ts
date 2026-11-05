import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentState, RefundState } from '@prisma/client';
import Stripe from 'stripe';
import {
  GatewayCreateInput,
  GatewayCreateResult,
  GatewayStatus,
  PaymentGateway,
} from './payment-gateway';

/** Client Stripe, ou null si STRIPE_SECRET_KEY n'est pas configurée. */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * Paiement par carte via Stripe (PAY-01), avec Stripe Connect (PAY-02) :
 * « destination charge » — les fonds vont au compte du restaurant, la
 * commission plateforme est prélevée via application_fee_amount.
 * Aucune donnée de carte ne transite par l'API (PCI-DSS délégué à Stripe).
 */
@Injectable()
export class StripeGateway implements PaymentGateway {
  readonly provider = 'STRIPE' as const;
  private readonly logger = new Logger(StripeGateway.name);

  constructor(@Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null) {}

  isEnabled(): boolean {
    return this.stripe !== null;
  }

  supports(method: PaymentMethod): boolean {
    return method === 'CARD';
  }

  private get client(): Stripe {
    if (!this.stripe) throw new Error('Stripe non configuré');
    return this.stripe;
  }

  async create(input: GatewayCreateInput): Promise<GatewayCreateResult> {
    const intent = await this.client.paymentIntents.create(
      {
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        description: input.description,
        metadata: { paymentId: input.paymentId },
        ...(input.destinationAccount && {
          application_fee_amount: input.applicationFee,
          transfer_data: { destination: input.destinationAccount },
        }),
      },
      // Une nouvelle tentative réseau ne crée pas un second PaymentIntent.
      { idempotencyKey: `payment-${input.paymentId}` },
    );
    return {
      providerRef: intent.id,
      clientSecret: intent.client_secret ?? undefined,
    };
  }

  async retrieve(providerRef: string): Promise<GatewayStatus> {
    return toGatewayStatus(
      await this.client.paymentIntents.retrieve(providerRef),
    );
  }

  async cancel(providerRef: string): Promise<void> {
    try {
      await this.client.paymentIntents.cancel(providerRef);
    } catch (err) {
      // Déjà confirmé ou annulé : le rapprochement tranchera.
      this.logger.warn(
        `Annulation impossible de ${providerRef} : ${String(err)}`,
      );
    }
  }

  async refund(providerRef: string, amount: number) {
    const refund = await this.client.refunds.create({
      payment_intent: providerRef,
      amount,
      // Destination charge : on reprend les fonds au restaurant et la commission.
      reverse_transfer: true,
      refund_application_fee: true,
    });
    const status: RefundState =
      refund.status === 'succeeded'
        ? 'SUCCEEDED'
        : refund.status === 'failed' || refund.status === 'canceled'
          ? 'FAILED'
          : 'PENDING';
    return { providerRef: refund.id, status };
  }
}

export function toGatewayStatus(intent: Stripe.PaymentIntent): GatewayStatus {
  let status: PaymentState = 'PENDING';
  if (intent.status === 'succeeded') status = 'SUCCEEDED';
  else if (intent.status === 'canceled') status = 'CANCELLED';
  else if (intent.last_payment_error) status = 'FAILED';
  return {
    status,
    amount:
      intent.status === 'succeeded' ? intent.amount_received : intent.amount,
    currency: intent.currency.toUpperCase(),
    failureReason: intent.last_payment_error?.message,
    clientSecret: intent.client_secret ?? undefined,
  };
}
