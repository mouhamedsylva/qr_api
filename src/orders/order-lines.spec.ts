import { HttpException } from '@nestjs/common';
import { buildOrderLines, OrderableMenuItem } from './order-lines';

const item = (over: Partial<OrderableMenuItem> = {}): OrderableMenuItem => ({
  id: 'item-1',
  name: 'Thiéboudienne',
  priceAmount: 3500,
  prepTimeMinutes: 20,
  isAvailable: true,
  availableAgainAt: null,
  stockQuantity: null,
  optionGroups: [
    {
      id: 'g-size',
      name: 'Taille',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: 'o-normal', name: 'Normale', priceDelta: 0, isAvailable: true },
        { id: 'o-large', name: 'Grande', priceDelta: 1000, isAvailable: true },
      ],
    },
  ],
  ...over,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return ((e as HttpException).getResponse() as { code: string }).code;
  }
  return null;
};

describe('buildOrderLines', () => {
  const menu = (i = item()) => new Map([[i.id, i]]);

  it('calcule le prix unitaire avec les options', () => {
    const { lines } = buildOrderLines(
      [{ menuItemId: 'item-1', quantity: 2, optionIds: ['o-large'] }],
      menu(),
    );
    expect(lines[0]).toMatchObject({
      unitPrice: 4500,
      lineTotal: 9000,
      options: [{ groupName: 'Taille', name: 'Grande', priceDelta: 1000 }],
    });
  });

  it('exige les choix obligatoires', () => {
    expect(
      codeOf(() =>
        buildOrderLines([{ menuItemId: 'item-1', quantity: 1 }], menu()),
      ),
    ).toBe('INVALID_OPTIONS');
  });

  it('refuse trop de choix et les options inconnues', () => {
    expect(
      codeOf(() =>
        buildOrderLines(
          [
            {
              menuItemId: 'item-1',
              quantity: 1,
              optionIds: ['o-normal', 'o-large'],
            },
          ],
          menu(),
        ),
      ),
    ).toBe('INVALID_OPTIONS');
    expect(
      codeOf(() =>
        buildOrderLines(
          [
            {
              menuItemId: 'item-1',
              quantity: 1,
              optionIds: ['o-normal', 'o-autre-article'],
            },
          ],
          menu(),
        ),
      ),
    ).toBe('INVALID_OPTIONS');
  });

  it('refuse un article épuisé ou inconnu', () => {
    expect(
      codeOf(() =>
        buildOrderLines(
          [{ menuItemId: 'item-1', quantity: 1, optionIds: ['o-normal'] }],
          menu(item({ isAvailable: false })),
        ),
      ),
    ).toBe('ITEM_UNAVAILABLE');
    expect(
      codeOf(() => buildOrderLines([{ menuItemId: 'x', quantity: 1 }], menu())),
    ).toBe('ITEM_NOT_FOUND');
  });

  it('cumule les quantités pour vérifier le stock limité', () => {
    const limited = item({ stockQuantity: 3 });
    const line = { menuItemId: 'item-1', quantity: 2, optionIds: ['o-normal'] };
    expect(codeOf(() => buildOrderLines([line, line], menu(limited)))).toBe(
      'OUT_OF_STOCK',
    );
    const { stockNeeded } = buildOrderLines([line], menu(limited));
    expect(stockNeeded.get('item-1')).toBe(2);
  });
});
