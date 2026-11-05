import {
  PaymentMethod,
  PaymentProvider,
  PaymentState,
  RefundState,
} from '@prisma/client';

export interface GatewayCreateInput {
  paymentId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  operator?: string;
  payerPhone?: string;
  /** Commission plateforme prélevée (PAY-02). */
  applicationFee: number;
  /** Compte connecté du restaurant qui reçoit les fonds. */
  destinationAccount?: string | null;
  description: string;
}

export interface GatewayCreateResult {
  providerRef: string;
  /** Carte : secret client pour confirmer (3-D Secure) avec Stripe.js. */
  clientSecret?: string;
  /** Mobile money : page de paiement de l'opérateur / agrégateur. */
  redirectUrl?: string;
}

export interface GatewayStatus {
  status: PaymentState;
  amount: number;
  currency: string;
  failureReason?: string;
  clientSecret?: string;
  redirectUrl?: string;
}

/**
 * Abstraction des fournisseurs de paiement (§15 : dépendance aux fournisseurs).
 * Ajouter un agrégateur mobile money (CinetPay, PayDunya, PayTech…) revient à
 * implémenter cette interface ; aucun autre code n'a à changer.
 */
export interface PaymentGateway {
  readonly provider: PaymentProvider;
  isEnabled(): boolean;
  supports(method: PaymentMethod): boolean;
  create(input: GatewayCreateInput): Promise<GatewayCreateResult>;
  /** État réel côté fournisseur : source de vérité pour le rapprochement (PAY-08). */
  retrieve(providerRef: string): Promise<GatewayStatus>;
  cancel(providerRef: string): Promise<void>;
  refund(
    providerRef: string,
    amount: number,
  ): Promise<{ providerRef: string; status: RefundState }>;
}
