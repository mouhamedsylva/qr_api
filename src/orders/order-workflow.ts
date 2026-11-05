import { OrderStatus } from '@prisma/client';

/**
 * Workflow de suivi (CMD-02) :
 * En attente → Acceptée → Préparation → Prête → Servie/Retirée → Terminée,
 * avec Annulée et Refusée comme états terminaux.
 */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['SERVED', 'COMPLETED', 'CANCELLED'],
  SERVED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

export const TERMINAL_STATUSES: OrderStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
];

/** Commandes encore actives (cuisine, salle, dashboard). */
export const ACTIVE_STATUSES: OrderStatus[] = [
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'SERVED',
];

/** Statuts imposant un motif (CMD-08). */
export const REASON_REQUIRED: OrderStatus[] = ['CANCELLED', 'REJECTED'];

/** Avant la mise en préparation, l'annulation remet le stock en place. */
export const STOCK_RESTORABLE_FROM: OrderStatus[] = ['PENDING', 'ACCEPTED'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Horodatage associé au nouveau statut. */
export function timestampFor(
  status: OrderStatus,
):
  'acceptedAt' | 'readyAt' | 'servedAt' | 'completedAt' | 'cancelledAt' | null {
  switch (status) {
    case 'ACCEPTED':
      return 'acceptedAt';
    case 'READY':
      return 'readyAt';
    case 'SERVED':
      return 'servedAt';
    case 'COMPLETED':
      return 'completedAt';
    case 'CANCELLED':
    case 'REJECTED':
      return 'cancelledAt';
    default:
      return null;
  }
}
