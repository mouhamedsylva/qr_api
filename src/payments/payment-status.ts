import { PaymentState, PaymentStatus } from '@prisma/client';

export interface PaymentLike {
  status: PaymentState;
  amount: number;
  refundedAmount: number;
}

const succeeded = (payments: PaymentLike[]) =>
  payments.filter((p) => p.status === 'SUCCEEDED');

/** Montant déjà encaissé (hors remboursements). */
export function amountPaid(payments: PaymentLike[]): number {
  return succeeded(payments).reduce((sum, p) => sum + p.amount, 0);
}

/** Reste à payer ; un remboursement ne rouvre pas la dette. */
export function amountDue(total: number, payments: PaymentLike[]): number {
  return Math.max(total - amountPaid(payments), 0);
}

/**
 * Statut de paiement d'une commande, dérivé de ses paiements :
 * paiements partiels (division d'addition), en attente, remboursés.
 */
export function computePaymentStatus(
  total: number,
  payments: PaymentLike[],
): PaymentStatus {
  const paid = amountPaid(payments);
  if (paid === 0) {
    return payments.some((p) => p.status === 'PENDING') ? 'PENDING' : 'UNPAID';
  }
  const refunded = succeeded(payments).reduce(
    (sum, p) => sum + p.refundedAmount,
    0,
  );
  if (refunded > 0) {
    return refunded >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }
  return paid >= total ? 'PAID' : 'PARTIALLY_PAID';
}
