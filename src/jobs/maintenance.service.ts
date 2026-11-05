import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 86_400_000;

/** Durées de conservation des données techniques. */
export const RETENTION = {
  realtimeEventsDays: 30, // fenêtre de rattrapage temps réel (NOT-06)
  refreshTokensDays: 30, // après expiration
  otpDays: 1, // après expiration
  webhookDeliveriesDays: 90,
  notificationsDays: 90,
};

/**
 * Purge des données techniques expirées. Les données métier et légales
 * (commandes, paiements, journal d'audit) ne sont jamais supprimées ici (CON-07).
 */
@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async purge(now = new Date()) {
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const [events, tokens, otps, deliveries, notifications] =
      await this.prisma.$transaction([
        this.prisma.realtimeEvent.deleteMany({
          where: { createdAt: { lt: ago(RETENTION.realtimeEventsDays) } },
        }),
        this.prisma.refreshToken.deleteMany({
          where: { expiresAt: { lt: ago(RETENTION.refreshTokensDays) } },
        }),
        this.prisma.otpCode.deleteMany({
          where: { expiresAt: { lt: ago(RETENTION.otpDays) } },
        }),
        this.prisma.webhookDelivery.deleteMany({
          where: {
            status: { not: 'PENDING' },
            createdAt: { lt: ago(RETENTION.webhookDeliveriesDays) },
          },
        }),
        this.prisma.notificationOutbox.deleteMany({
          where: {
            status: { not: 'PENDING' },
            createdAt: { lt: ago(RETENTION.notificationsDays) },
          },
        }),
      ]);
    return {
      realtimeEvents: events.count,
      refreshTokens: tokens.count,
      otpCodes: otps.count,
      webhookDeliveries: deliveries.count,
      notifications: notifications.count,
    };
  }
}
