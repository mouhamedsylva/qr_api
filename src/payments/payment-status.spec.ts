import { amountDue, computePaymentStatus, PaymentLike } from './payment-status';

const p = (
  status: PaymentLike['status'],
  amount: number,
  refundedAmount = 0,
): PaymentLike => ({ status, amount, refundedAmount });

describe('statut de paiement', () => {
  it('non payée ou en attente', () => {
    expect(computePaymentStatus(5000, [])).toBe('UNPAID');
    expect(computePaymentStatus(5000, [p('FAILED', 5000)])).toBe('UNPAID');
    expect(computePaymentStatus(5000, [p('PENDING', 5000)])).toBe('PENDING');
  });

  it('payée en une ou plusieurs fois', () => {
    expect(computePaymentStatus(5000, [p('SUCCEEDED', 5000)])).toBe('PAID');
    expect(computePaymentStatus(5000, [p('SUCCEEDED', 2000)])).toBe(
      'PARTIALLY_PAID',
    );
    expect(
      computePaymentStatus(5000, [p('SUCCEEDED', 2000), p('SUCCEEDED', 3000)]),
    ).toBe('PAID');
  });

  it('remboursée partiellement ou totalement', () => {
    expect(computePaymentStatus(5000, [p('SUCCEEDED', 5000, 1000)])).toBe(
      'PARTIALLY_REFUNDED',
    );
    expect(computePaymentStatus(5000, [p('SUCCEEDED', 5000, 5000)])).toBe(
      'REFUNDED',
    );
  });

  it('calcule le reste à payer sans compter les paiements non aboutis', () => {
    expect(
      amountDue(5000, [
        p('SUCCEEDED', 2000),
        p('PENDING', 3000),
        p('FAILED', 3000),
      ]),
    ).toBe(3000);
    expect(amountDue(5000, [p('SUCCEEDED', 5000, 5000)])).toBe(0);
  });
});
