import { computeDiscount, DiscountRule } from './discount';

const rule = (over: Partial<DiscountRule>): DiscountRule => ({
  type: 'PERCENT',
  value: 0,
  buyQuantity: null,
  freeQuantity: null,
  menuItemId: null,
  maxDiscount: null,
  ...over,
});

const lines = [
  { menuItemId: 'thieb', quantity: 2, basePrice: 3500 },
  { menuItemId: 'bissap', quantity: 3, basePrice: 500 },
];
const subtotal = 8500;

describe('computeDiscount', () => {
  it('applique un pourcentage plafonné', () => {
    expect(computeDiscount(rule({ value: 1000 }), lines, subtotal)).toBe(850);
    expect(
      computeDiscount(rule({ value: 1000, maxDiscount: 500 }), lines, subtotal),
    ).toBe(500);
  });

  it('applique un montant fixe sans dépasser le sous-total', () => {
    expect(
      computeDiscount(rule({ type: 'AMOUNT', value: 1000 }), lines, subtotal),
    ).toBe(1000);
    expect(
      computeDiscount(rule({ type: 'AMOUNT', value: 99999 }), lines, subtotal),
    ).toBe(subtotal);
  });

  it('offre Y articles pour X achetés', () => {
    const bogo = rule({
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      freeQuantity: 1,
      menuItemId: 'bissap',
    });
    expect(computeDiscount(bogo, lines, subtotal)).toBe(500); // 3 bissaps → 1 offert
    expect(
      computeDiscount(
        bogo,
        [{ menuItemId: 'bissap', quantity: 2, basePrice: 500 }],
        1000,
      ),
    ).toBe(0); // 2 seulement : pas encore de gratuité
    expect(
      computeDiscount(
        bogo,
        [{ menuItemId: 'bissap', quantity: 6, basePrice: 500 }],
        3000,
      ),
    ).toBe(1000);
  });

  it('offre un article présent dans le panier', () => {
    const free = rule({ type: 'FREE_ITEM', menuItemId: 'bissap' });
    expect(computeDiscount(free, lines, subtotal)).toBe(500);
    expect(computeDiscount(free, [lines[0]], 7000)).toBe(0);
  });
});
