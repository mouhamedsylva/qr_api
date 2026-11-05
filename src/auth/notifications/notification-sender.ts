import type { NotificationChannel } from '@prisma/client';

export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');

export interface OutgoingMessage {
  channel: NotificationChannel;
  to: string;
  subject?: string;
  body: string;
  /** Nom du modèle (otp, invitation, order_ready…), pour le suivi. */
  template?: string;
}

/**
 * Abstraction d'envoi (email, SMS, WhatsApp). L'implémentation est fournie
 * par le module Notifications (file d'envoi persistante).
 */
export interface NotificationSender {
  send(message: OutgoingMessage): Promise<void>;
}
