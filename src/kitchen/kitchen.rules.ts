import { KitchenItemStatus, OrderStatus } from '@prisma/client';

/** Transitions d'une ligne en cuisine ; READY → IN_PROGRESS permet de corriger un « prêt » prématuré. */
const ITEM_TRANSITIONS: Record<KitchenItemStatus, KitchenItemStatus[]> = {
  PENDING: ['IN_PROGRESS', 'READY'],
  IN_PROGRESS: ['READY'],
  READY: ['IN_PROGRESS'],
};

export function canMoveItem(
  from: KitchenItemStatus,
  to: KitchenItemStatus,
): boolean {
  return ITEM_TRANSITIONS[from].includes(to);
}

/** Commandes visibles en cuisine. */
export const KITCHEN_ORDER_STATUSES: OrderStatus[] = ['ACCEPTED', 'PREPARING'];

/**
 * Statut de commande déduit de l'avancement des lignes : la première ligne
 * lancée passe la commande « en préparation », la dernière ligne prête la
 * passe « prête » (le client et la salle sont alors notifiés).
 * Renvoie null si le statut ne change pas.
 */
export function deriveOrderStatus(
  current: OrderStatus,
  items: KitchenItemStatus[],
): OrderStatus | null {
  if (!KITCHEN_ORDER_STATUSES.includes(current) || items.length === 0) {
    return null;
  }
  if (items.every((s) => s === 'READY')) return 'READY';
  if (current === 'ACCEPTED' && items.some((s) => s !== 'PENDING')) {
    return 'PREPARING';
  }
  return null;
}

export type Urgency = 'normal' | 'warning' | 'late';

/**
 * Code couleur selon l'ancienneté (KDS-01) : « en retard » au-delà de
 * l'heure estimée, « attention » après 75 % du délai prévu.
 */
export function computeUrgency(
  createdAt: Date,
  estimatedReadyAt: Date | null,
  now: Date = new Date(),
): Urgency {
  if (!estimatedReadyAt) return 'normal';
  if (now >= estimatedReadyAt) return 'late';
  const window = estimatedReadyAt.getTime() - createdAt.getTime();
  const elapsed = now.getTime() - createdAt.getTime();
  return window > 0 && elapsed >= window * 0.75 ? 'warning' : 'normal';
}

const URGENCY_RANK: Record<Urgency, number> = {
  late: 0,
  warning: 1,
  normal: 2,
};

/** Ordre d'affichage : prioritaires, puis en retard, puis les plus anciens. */
export function compareTickets(
  a: { isRush: boolean; urgency: Urgency; createdAt: Date },
  b: { isRush: boolean; urgency: Urgency; createdAt: Date },
): number {
  if (a.isRush !== b.isRush) return a.isRush ? -1 : 1;
  if (a.urgency !== b.urgency) {
    return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}
