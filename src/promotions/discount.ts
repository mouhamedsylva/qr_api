import { PromotionType } from '@prisma/client';

export interface DiscountRule {
  type: PromotionType;
  value: number;
  buyQuantity: number | null;
  freeQuantity: number | null;
  menuItemId: string | null;
  maxDiscount: number | null;
}

export interface DiscountLine {
  menuItemId: string;
  quantity: number;
  /** Prix de base de l'article, hors options. */
  basePrice: number;
}

/**
 * Montant de remise d'une promotion sur un panier (CMD-13), en plus petite
 * unité monétaire. Les articles offerts le sont à leur prix de base : les
 * suppléments restent payants. Le résultat ne dépasse jamais `maxDiscount`
 * ni le sous-total.
 */
export function computeDiscount(
  rule: DiscountRule,
  lines: DiscountLine[],
  subtotal: number,
): number {
  const target = rule.menuItemId
    ? lines.filter((l) => l.menuItemId === rule.menuItemId)
    : [];
  const cheapestTarget = target.length
    ? Math.min(...target.map((l) => l.basePrice))
    : 0;

  let discount = 0;
  switch (rule.type) {
    case 'PERCENT':
      discount = Math.round((subtotal * rule.value) / 10_000);
      break;
    case 'AMOUNT':
      discount = rule.value;
      break;
    case 'BUY_X_GET_Y': {
      const buy = rule.buyQuantity ?? 0;
      const free = rule.freeQuantity ?? 0;
      if (buy < 1 || free < 1) break;
      const quantity = target.reduce((s, l) => s + l.quantity, 0);
      // Les articles offerts sont les moins chers du lot.
      discount = Math.floor(quantity / (buy + free)) * free * cheapestTarget;
      break;
    }
    case 'FREE_ITEM':
      discount = cheapestTarget;
      break;
  }

  if (rule.maxDiscount !== null)
    discount = Math.min(discount, rule.maxDiscount);
  return Math.max(0, Math.min(discount, subtotal));
}
