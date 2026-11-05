/** Points gagnés pour un montant dépensé (hors pourboire). */
export function pointsForAmount(
  amount: number,
  program: { pointsPerUnit: number; unitAmount: number },
): number {
  if (amount <= 0 || program.unitAmount <= 0) return 0;
  return Math.floor(amount / program.unitAmount) * program.pointsPerUnit;
}

/**
 * Expiration paramétrable : les points sont perdus après `expiryDays` jours
 * sans activité (gain ou échange). null = pas d'expiration.
 */
export function isExpired(
  lastActivityAt: Date,
  expiryDays: number | null,
  now: Date = new Date(),
): boolean {
  if (!expiryDays) return false;
  return now.getTime() - lastActivityAt.getTime() > expiryDays * 86_400_000;
}
