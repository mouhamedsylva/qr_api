import { SubscriptionStatus } from '@prisma/client';

const DAY_MS = 86_400_000;
export const TRIAL_REMINDER_DAYS = 3;
export const GRACE_PERIOD_DAYS = 7;

export type SubscriptionNotice =
  'TRIAL_ENDING' | 'TRIAL_ENDED' | 'PAYMENT_DUE' | 'SUSPENDED';

export interface LifecycleInput {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  lastNotice: string | null;
}

export interface LifecycleChange {
  status?: SubscriptionStatus;
  graceUntil?: Date;
  notice: SubscriptionNotice;
}

/**
 * Échéances d'un abonnement (PAY-12) : rappel avant fin d'essai, passage en
 * impayé avec période de grâce à l'échéance, puis suspension. Chaque relance
 * n'est envoyée qu'une fois (`lastNotice`). null = rien à faire.
 */
export function nextLifecycleStep(
  sub: LifecycleInput,
  now: Date = new Date(),
  reminderDays: number = TRIAL_REMINDER_DAYS,
): LifecycleChange | null {
  const t = now.getTime();
  switch (sub.status) {
    case 'TRIALING': {
      if (!sub.trialEndsAt) return null;
      const left = sub.trialEndsAt.getTime() - t;
      if (left <= 0) {
        return sub.lastNotice === 'TRIAL_ENDED'
          ? null
          : { notice: 'TRIAL_ENDED' };
      }
      if (
        reminderDays > 0 &&
        left <= reminderDays * DAY_MS &&
        !sub.lastNotice
      ) {
        return { notice: 'TRIAL_ENDING' };
      }
      return null;
    }
    case 'ACTIVE':
      if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= t) {
        return {
          status: 'PAST_DUE',
          graceUntil: new Date(t + GRACE_PERIOD_DAYS * DAY_MS),
          notice: 'PAYMENT_DUE',
        };
      }
      return null;
    case 'PAST_DUE':
      if (!sub.graceUntil) {
        return {
          graceUntil: new Date(t + GRACE_PERIOD_DAYS * DAY_MS),
          notice: 'PAYMENT_DUE',
        };
      }
      if (sub.graceUntil.getTime() <= t) {
        return { status: 'SUSPENDED', notice: 'SUSPENDED' };
      }
      return null;
    default:
      return null;
  }
}
