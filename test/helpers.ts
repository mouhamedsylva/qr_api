import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DEFAULT_PLANS } from '../src/billing/plans.defaults';
import { configureApp } from '../src/app.setup';
import {
  NOTIFICATION_SENDER,
  OutgoingMessage,
} from '../src/auth/notifications/notification-sender';
import { PrismaService } from '../src/prisma/prisma.service';

export const PASSWORD = 'Secret123';

/** Capture les messages envoyés pour lire les codes OTP. */
export class FakeSender {
  messages: OutgoingMessage[] = [];
  send(message: OutgoingMessage) {
    this.messages.push(message);
    return Promise.resolve();
  }
  lastCodeFor(to: string): string {
    const msg = [...this.messages].reverse().find((m) => m.to === to);
    return /(\d{6})/.exec(msg?.body ?? '')?.[1] ?? '';
  }
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  restaurantId: string;
  slug: string;
}

export interface ProviderOverride {
  token: string | symbol | (abstract new (...args: never[]) => unknown);
  value: unknown;
}

/** `sender: null` : vraies notifications (file d'envoi, SMTP). */
export async function createTestApp(
  sender: FakeSender | null = new FakeSender(),
  overrides: ProviderOverride[] = [],
) {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (sender) {
    builder = builder.overrideProvider(NOTIFICATION_SENDER).useValue(sender);
  }
  for (const { token, value } of overrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), sender };
}

/** Vide la base de test dans l'ordre des dépendances. */
export async function resetDatabase(prisma: PrismaService) {
  await prisma.$transaction([
    // Le journal d'audit est protégé par trigger : purge explicite (base de test).
    prisma.$executeRawUnsafe('SET @allow_audit_purge = 1'),
    prisma.auditLog.deleteMany(),
    prisma.$executeRawUnsafe('SET @allow_audit_purge = NULL'),
    prisma.invitation.deleteMany(),
    prisma.subscription.deleteMany(),
    // Les forfaits par défaut sont recréés au démarrage ; les autres viennent des tests.
    prisma.plan.deleteMany({
      where: { code: { notIn: DEFAULT_PLANS.map((p) => p.code) } },
    }),
    prisma.otpCode.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.realtimeEvent.deleteMany(),
    prisma.notificationOutbox.deleteMany(),
    prisma.jobLock.deleteMany(),
    prisma.paymentWebhookEvent.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.review.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.promotionRedemption.deleteMany(),
    prisma.promotion.deleteMany(),
    prisma.loyaltyTransaction.deleteMany(),
    prisma.loyaltyAccount.deleteMany(),
    prisma.loyaltyReward.deleteMany(),
    prisma.loyaltyProgram.deleteMany(),
    prisma.option.deleteMany(),
    prisma.optionGroup.deleteMany(),
    prisma.menuItem.deleteMany(),
    prisma.category.updateMany({ data: { parentId: null } }),
    prisma.category.deleteMany(),
    prisma.webhookDelivery.deleteMany(),
    prisma.webhookEndpoint.deleteMany(),
    prisma.apiKey.deleteMany(),
    prisma.station.deleteMany(),
    prisma.diningTable.deleteMany(),
    prisma.zone.deleteMany(),
    prisma.membership.deleteMany(),
    prisma.openingHour.deleteMany(),
    prisma.closurePeriod.deleteMany(),
    prisma.restaurant.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

export const bearer = (s: { accessToken: string }) => ({
  Authorization: `Bearer ${s.accessToken}`,
});

export async function registerOwner(
  app: INestApplication<App>,
  email: string,
  restaurantName: string,
): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      firstName: 'Awa',
      lastName: 'Diop',
      restaurantName,
      acceptTerms: true,
    })
    .expect(201);
  return {
    accessToken: res.body.tokens.accessToken,
    refreshToken: res.body.tokens.refreshToken,
    restaurantId: res.body.restaurant.id,
    slug: res.body.restaurant.slug,
  };
}

/** Crée un membre (STAFF par défaut) et renvoie son jeton d'accès. */
export async function createMember(
  app: INestApplication<App>,
  prisma: PrismaService,
  email: string,
  restaurantId: string,
  role: Role = 'STAFF',
): Promise<{ accessToken: string; userId: string }> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hash(PASSWORD),
      firstName: 'Moussa',
      lastName: 'Fall',
      memberships: { create: { restaurantId, role } },
    },
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { accessToken: res.body.tokens.accessToken, userId: user.id };
}

/** Crée un super-admin (équipe plateforme) et renvoie son jeton d'accès. */
export async function createSuperAdmin(
  app: INestApplication<App>,
  prisma: PrismaService,
  email: string,
): Promise<{ accessToken: string; userId: string }> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hash(PASSWORD),
      firstName: 'Admin',
      lastName: 'Plateforme',
      isSuperAdmin: true,
    },
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { accessToken: res.body.tokens.accessToken, userId: user.id };
}
