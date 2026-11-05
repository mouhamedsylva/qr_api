import { SubscriptionStatus } from '@prisma/client';

export interface SubscriptionLike {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
}

/**
 * Un abonnement donne droit à son forfait s'il est actif, en essai non expiré,
 * ou impayé mais encore en période de grâce (PAY-12). Sinon, l'établissement
 * bascule sur le forfait de repli (Starter) sans perte de données.
 */
export function isSubscriptionEntitled(
  sub: SubscriptionLike | null,
  now: Date = new Date(),
): boolean {
  if (!sub) return false;
  switch (sub.status) {
    case 'ACTIVE':
      return !sub.currentPeriodEnd || sub.currentPeriodEnd > now;
    case 'TRIALING':
      return !!sub.trialEndsAt && sub.trialEndsAt > now;
    case 'PAST_DUE':
      return !!sub.graceUntil && sub.graceUntil > now;
    default:
      return false;
  }
}
