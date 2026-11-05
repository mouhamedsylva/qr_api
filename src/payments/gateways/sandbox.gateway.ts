import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  GatewayCreateInput,
  GatewayCreateResult,
  GatewayStatus,
  PaymentGateway,
} from './payment-gateway';

/**
 * Simulateur de paiement (dev / tests uniquement, interdit en production).
 * Reproduit le parcours mobile money d'un agrégateur : page de paiement,
 * puis confirmation asynchrone de l'opérateur, simulée via
 * POST /public/payments/:id/sandbox.
 */
@Injectable()
export class SandboxGateway implements PaymentGateway {
  readonly provider = 'SANDBOX' as const;
  private readonly enabled: boolean;
  private readonly clientUrl: string;
  private readonly states = new Map<string, GatewayStatus>();

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('PAYMENTS_SANDBOX_ENABLED') === true;
    this.clientUrl = config.getOrThrow<string>('CLIENT_APP_URL');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  supports(method: PaymentMethod): boolean {
    return method === 'CARD' || method === 'MOBILE_MONEY';
  }

  create(input: GatewayCreateInput): Promise<GatewayCreateResult> {
    const providerRef = `sbx_${randomUUID()}`;
    const redirectUrl = `${this.clientUrl.replace(/\/+$/, '')}/sandbox-pay/${input.paymentId}`;
    this.states.set(providerRef, {
      status: 'PENDING',
      amount: input.amount,
      currency: input.currency,
      redirectUrl,
    });
    return Promise.resolve({ providerRef, redirectUrl });
  }

  /** Simule la notification de l'opérateur. */
  simulate(providerRef: string, outcome: GatewayStatus): void {
    this.states.set(providerRef, outcome);
  }

  retrieve(providerRef: string): Promise<GatewayStatus> {
    const state = this.states.get(providerRef);
    if (!state) {
      return Promise.reject(
        new Error(`Paiement sandbox inconnu : ${providerRef}`),
      );
    }
    return Promise.resolve(state);
  }

  cancel(providerRef: string): Promise<void> {
    const state = this.states.get(providerRef);
    if (state?.status === 'PENDING') {
      this.states.set(providerRef, { ...state, status: 'CANCELLED' });
    }
    return Promise.resolve();
  }

  refund(): Promise<{ providerRef: string; status: 'SUCCEEDED' }> {
    return Promise.resolve({
      providerRef: `sbx_re_${randomUUID()}`,
      status: 'SUCCEEDED',
    });
  }
}
