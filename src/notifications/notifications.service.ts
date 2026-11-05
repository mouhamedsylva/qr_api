import { Injectable, Logger } from '@nestjs/common';
import type {
  NotificationSender,
  OutgoingMessage,
} from '../auth/notifications/notification-sender';
import { PrismaService } from '../prisma/prisma.service';
import { TransportRegistry } from './transports';

/** Délais entre tentatives : 1 min, 5 min, 30 min, puis abandon. */
export const NOTIFICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const LEASE_MS = 2 * 60_000;
const BATCH_SIZE = 100;

/**
 * Envoi des notifications (NOT-04) par file persistante : chaque message est
 * enregistré puis envoyé aussitôt ; un échec (SMTP indisponible…) est
 * retenté par la tâche planifiée, sans jamais bloquer l'opération métier.
 */
@Injectable()
export class NotificationsService implements NotificationSender {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transports: TransportRegistry,
  ) {}

  async send(message: OutgoingMessage): Promise<void> {
    const row = await this.prisma.notificationOutbox.create({
      data: {
        channel: message.channel,
        to: message.to,
        subject: message.subject,
        body: message.body,
        template: message.template,
        nextAttemptAt: new Date(),
      },
    });
    this.deliver(row.id).catch((err) => this.logger.error(err));
  }

  async processDue(): Promise<number> {
    const due = await this.prisma.notificationOutbox.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });
    for (const { id } of due) await this.deliver(id);
    return due.length;
  }

  /** Une tentative, réservée de façon atomique (sûr en multi-instances). */
  async deliver(id: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.notificationOutbox.updateMany({
      where: { id, status: 'PENDING', nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count === 0) return;

    const row = await this.prisma.notificationOutbox.findUniqueOrThrow({
      where: { id },
    });
    const attempts = row.attempts + 1;
    try {
      await this.transports.for(row.channel).send(row);
      await this.prisma.notificationOutbox.update({
        where: { id },
        data: { status: 'SENT', attempts, sentAt: new Date(), lastError: null },
      });
    } catch (err) {
      const delay = NOTIFICATION_RETRY_DELAYS_MS[attempts - 1];
      await this.prisma.notificationOutbox.update({
        where: { id },
        data: {
          attempts,
          lastError: (err as Error).message.slice(0, 500),
          ...(delay === undefined
            ? { status: 'FAILED' }
            : { nextAttemptAt: new Date(Date.now() + delay) }),
        },
      });
    }
  }
}
