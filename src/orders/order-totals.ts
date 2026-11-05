export interface TaxSettings {
  taxEnabled: boolean;
  taxRateBp: number; // 1800 = 18 %
  pricesIncludeTax: boolean;
  serviceFeeBp: number;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  serviceFee: number;
  tipAmount: number;
  total: number;
}

/** Arrondi à l'unité monétaire la plus proche (demi vers le haut). */
const round = (value: number) => Math.round(value);

/**
 * Totalisation d'une commande (CMD-04). Tous les montants sont des entiers en
 * plus petite unité monétaire.
 * - Prix TTC : la TVA est extraite du montant (incluse, non ajoutée).
 * - Prix HT : la TVA est ajoutée.
 * - Les frais de service s'appliquent au montant après remise ; le pourboire s'ajoute à la fin.
 */
export function computeTotals(
  lineTotals: number[],
  settings: TaxSettings,
  discount = 0,
  tip = 0,
): OrderTotals {
  const subtotal = lineTotals.reduce((sum, line) => sum + line, 0);
  const discountTotal = Math.min(Math.max(discount, 0), subtotal);
  const net = subtotal - discountTotal;

  const rate = settings.taxEnabled ? settings.taxRateBp : 0;
  const taxTotal = settings.pricesIncludeTax
    ? round((net * rate) / (10_000 + rate))
    : round((net * rate) / 10_000);
  const serviceFee = round((net * settings.serviceFeeBp) / 10_000);
  const tipAmount = Math.max(tip, 0);

  const total =
    net + (settings.pricesIncludeTax ? 0 : taxTotal) + serviceFee + tipAmount;

  return { subtotal, discountTotal, taxTotal, serviceFee, tipAmount, total };
}
