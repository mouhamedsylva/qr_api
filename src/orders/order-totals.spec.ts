import { computeTotals, TaxSettings } from './order-totals';

const noTax: TaxSettings = {
  taxEnabled: false,
  taxRateBp: 0,
  pricesIncludeTax: true,
  serviceFeeBp: 0,
};

describe('computeTotals', () => {
  it('additionne les lignes sans taxe', () => {
    expect(computeTotals([3500, 1000], noTax)).toEqual({
      subtotal: 4500,
      discountTotal: 0,
      taxTotal: 0,
      serviceFee: 0,
      tipAmount: 0,
      total: 4500,
    });
  });

  it('extrait la TVA de prix TTC sans changer le total', () => {
    const t = computeTotals([11800], {
      ...noTax,
      taxEnabled: true,
      taxRateBp: 1800,
    });
    expect(t.taxTotal).toBe(1800);
    expect(t.total).toBe(11800);
  });

  it('ajoute la TVA à des prix HT', () => {
    const t = computeTotals([10000], {
      ...noTax,
      taxEnabled: true,
      taxRateBp: 1800,
      pricesIncludeTax: false,
    });
    expect(t.taxTotal).toBe(1800);
    expect(t.total).toBe(11800);
  });

  it('ignore le taux quand la TVA est désactivée', () => {
    const t = computeTotals([10000], { ...noTax, taxRateBp: 1800 });
    expect(t.taxTotal).toBe(0);
  });

  it('applique frais de service, remise et pourboire', () => {
    const t = computeTotals(
      [10000],
      { ...noTax, serviceFeeBp: 500 },
      2000,
      300,
    );
    expect(t).toMatchObject({
      subtotal: 10000,
      discountTotal: 2000,
      serviceFee: 400, // 5 % de 8000
      tipAmount: 300,
      total: 8700,
    });
  });

  it('plafonne la remise au sous-total', () => {
    expect(computeTotals([1000], noTax, 5000).total).toBe(0);
  });

  it('arrondit à l’unité', () => {
    const t = computeTotals([999], { ...noTax, serviceFeeBp: 1000 });
    expect(t.serviceFee).toBe(100); // 99,9 → 100
  });
});
