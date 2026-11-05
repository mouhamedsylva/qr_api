import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { JobsService } from '../src/jobs/jobs.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { TransportRegistry } from '../src/notifications/transports';
import { SandboxGateway } from '../src/payments/gateways/sandbox.gateway';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createSuperAdmin,
  createTestApp,
  PASSWORD,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

/** API de Mailpit (serveur SMTP de test de Laragon). */
const MAILPIT = 'http://localhost:8025/api/v1';

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function mailsTo(address: string): Promise<MailSummary[]> {
  const res = await fetch(
    `${MAILPIT}/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await res.json()) as { messages: MailSummary[] }).messages;
}

async function mailText(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}

/** Attend qu'un email (envoi asynchrone) arrive dans Mailpit. */
async function waitForMail(
  address: string,
  subject: RegExp,
): Promise<MailSummary> {
  for (let i = 0; i < 60; i++) {
    const found = (await mailsTo(address)).find((m) => subject.test(m.Subject));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Aucun email « ${String(subject)} » pour ${address}`);
}

describe('Infrastructure : notifications et tâches planifiées (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jobs: JobsService;
  let owner: Session;
  let admin: { accessToken: string };
  let itemId: string;
  const run = (name: string) => jobs.run(name);
  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/restaurants/${owner.restaurantId}`;
  const ownerEmail = `infra.${Date.now()}@test.sn`;

  beforeAll(async () => {
    const mailpit = await fetch(`${MAILPIT}/info`).catch(() => null);
    if (!mailpit?.ok) {
      throw new Error(
        'Mailpit doit tourner (Laragon) : SMTP localhost:1025, API localhost:8025',
      );
    }
    ({ app, prisma } = await createTestApp(null)); // vraies notifications
    jobs = app.get(JobsService);
    await resetDatabase(prisma);
    owner = await registerOwner(app, ownerEmail, 'Chez Infra');
    admin = await createSuperAdmin(app, prisma, `admin.${Date.now()}@test.sn`);

    await api()
      .put(`${base()}/opening-hours`)
      .set(bearer(owner))
      .send({
        hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
          dayOfWeek: d,
          opensAt: '00:00',
          closesAt: '00:00',
        })),
      })
      .expect(200);
    const category = await api()
      .post(`${base()}/menu/categories`)
      .set(bearer(owner))
      .send({ name: 'Carte' });
    itemId = (
      await api()
        .post(`${base()}/menu/items`)
        .set(bearer(owner))
        .send({ categoryId: category.body.id, name: 'Mafé', priceAmount: 2500 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('notifications (NOT-02, NOT-04)', () => {
    it('envoie le code de vérification par email via SMTP', async () => {
      const mail = await waitForMail(
        ownerEmail,
        /Vérification de votre adresse email/,
      );
      const code = /(\d{6})/.exec(await mailText(mail.ID))?.[1];
      expect(code).toMatch(/^\d{6}$/);

      const res = await api()
        .post('/api/v1/auth/otp/verify')
        .set(bearer(owner))
        .send({ channel: 'EMAIL', code })
        .expect(200);
      expect(res.body.emailVerified).toBe(true);
      const row = await prisma.notificationOutbox.findFirstOrThrow({
        where: { to: ownerEmail },
      });
      expect(row).toMatchObject({
        channel: 'EMAIL',
        status: 'SENT',
        attempts: 1,
      });
    });

    it('prévient le client quand sa commande est prête, puis lui envoie son reçu', async () => {
      const customerEmail = `client.${Date.now()}@test.sn`;
      const customer = (
        await api()
          .post('/api/v1/auth/customers/register')
          .send({
            email: customerEmail,
            password: PASSWORD,
            firstName: 'Ndeye',
            lastName: 'Sow',
            acceptTerms: true,
          })
          .expect(201)
      ).body.tokens;
      const order = (
        await api()
          .post('/api/v1/public/orders')
          .set(bearer(customer))
          .set('Idempotency-Key', `infra-${randomUUID()}`)
          .send({
            mode: 'TAKEAWAY',
            restaurantSlug: owner.slug,
            customerPhone: '+221770001122',
            items: [{ menuItemId: itemId, quantity: 2 }],
          })
          .expect(201)
      ).body.order;

      for (const status of ['ACCEPTED', 'READY']) {
        await api()
          .patch(`${base()}/orders/${order.id}/status`)
          .set(bearer(owner))
          .send({ status })
          .expect(200);
      }
      const ready = await waitForMail(customerEmail, /est prête/);
      expect(await mailText(ready.ID)).toContain(
        `commande n°${order.number} est prête, à retirer au comptoir`,
      );
      const sms = await prisma.notificationOutbox.findFirstOrThrow({
        where: { channel: 'SMS', to: '+221770001122' },
      });
      expect(sms).toMatchObject({ template: 'order_ready', status: 'SENT' });

      await api()
        .post(`${base()}/orders/${order.id}/payments/cash`)
        .set(bearer(owner))
        .set('Idempotency-Key', `cash-${randomUUID()}`)
        .send({})
        .expect(201);
      const receipt = await waitForMail(customerEmail, /Votre reçu R-000001/);
      expect(await mailText(receipt.ID)).toContain('Montant réglé : 5 000 XOF');
    });

    it('retente un envoi en échec via la tâche planifiée', async () => {
      // Panne SMTP simulée sur la première tentative uniquement.
      const spy = jest
        .spyOn(app.get(TransportRegistry), 'for')
        .mockReturnValueOnce({
          name: 'panne',
          send: () => Promise.reject(new Error('SMTP indisponible')),
        });
      const to = `retry.${Date.now()}@test.sn`;
      await app.get(NotificationsService).send({
        channel: 'EMAIL',
        to,
        subject: 'Test reprise',
        body: 'Bonjour',
      });
      let failed = await prisma.notificationOutbox.findFirstOrThrow({
        where: { to },
      });
      for (let i = 0; i < 30 && failed.attempts === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        failed = await prisma.notificationOutbox.findUniqueOrThrow({
          where: { id: failed.id },
        });
      }
      expect(failed).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'SMTP indisponible',
      });
      spy.mockRestore();

      // Pas encore dû : rien à faire. Dû : envoyé à la 2e tentative.
      await run('notifications');
      expect(
        (
          await prisma.notificationOutbox.findUniqueOrThrow({
            where: { id: failed.id },
          })
        ).status,
      ).toBe('PENDING');
      await prisma.notificationOutbox.update({
        where: { id: failed.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await run('notifications');
      expect(
        await prisma.notificationOutbox.findUniqueOrThrow({
          where: { id: failed.id },
        }),
      ).toMatchObject({
        status: 'SENT',
        attempts: 2,
      });
      await waitForMail(to, /Test reprise/);
    });
  });

  describe('tâches planifiées', () => {
    it('n’exécute une tâche que sur une instance à la fois', async () => {
      const first = await run('maintenance');
      expect(first).toMatchObject({ job: 'maintenance', ran: true });
      await prisma.jobLock.update({
        where: { name: 'maintenance' },
        data: {
          lockedUntil: new Date(Date.now() + 60_000),
          owner: 'autre-instance',
        },
      });
      expect(await run('maintenance')).toMatchObject({ ran: false });
      await prisma.jobLock.update({
        where: { name: 'maintenance' },
        data: { lockedUntil: new Date(0) },
      });
    });

    it('applique les échéances d’abonnement et prévient le propriétaire (PAY-12)', async () => {
      const userId = (
        await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
      ).id;
      await prisma.subscription.update({
        where: { userId },
        data: { trialEndsAt: new Date(Date.now() + 2 * 86_400_000) },
      });
      await run('subscriptions');
      await waitForMail(ownerEmail, /se termine bientôt/);
      await run('subscriptions'); // relance non répétée
      expect(
        (await mailsTo(ownerEmail)).filter((m) =>
          /se termine bientôt/.test(m.Subject),
        ),
      ).toHaveLength(1);

      // Période payée arrivée à échéance → impayé avec 7 jours de grâce.
      await api()
        .patch(`/api/v1/admin/subscriptions/${userId}`)
        .set(bearer(admin))
        .send({
          status: 'ACTIVE',
          currentPeriodEnd: new Date(Date.now() - 1000).toISOString(),
        })
        .expect(200);
      await run('subscriptions');
      let sub = await prisma.subscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(sub).toMatchObject({
        status: 'PAST_DUE',
        lastNotice: 'PAYMENT_DUE',
      });
      expect(sub.graceUntil!.getTime()).toBeGreaterThan(
        Date.now() + 6 * 86_400_000,
      );
      await waitForMail(ownerEmail, /Paiement de votre abonnement/);

      // Grâce écoulée → suspension, forfait de repli.
      await prisma.subscription.update({
        where: { userId },
        data: { graceUntil: new Date(Date.now() - 1000) },
      });
      await run('subscriptions');
      sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
      expect(sub.status).toBe('SUSPENDED');
      await waitForMail(ownerEmail, /est suspendu/);
      const overview = await api()
        .get('/api/v1/billing/subscription')
        .set(bearer(owner))
        .expect(200);
      expect(overview.body).toMatchObject({
        isFallback: true,
        effectivePlan: { code: 'STARTER' },
      });
    });

    it('rapproche les paiements en ligne restés en attente (PAY-08)', async () => {
      const pay = async () => {
        const created = (
          await api()
            .post('/api/v1/public/orders')
            .set('Idempotency-Key', `pay-${randomUUID()}`)
            .send({
              mode: 'TAKEAWAY',
              restaurantSlug: owner.slug,
              items: [{ menuItemId: itemId, quantity: 1 }],
            })
            .expect(201)
        ).body;
        const payment = (
          await api()
            .post(`/api/v1/public/orders/${created.order.id}/payments`)
            .set('X-Order-Token', created.trackingToken)
            .set('Idempotency-Key', `mm-${randomUUID()}`)
            .send({ method: 'MOBILE_MONEY', operator: 'WAVE' })
            .expect(201)
        ).body;
        return prisma.payment.findUniqueOrThrow({
          where: { id: payment.paymentId },
        });
      };
      // Confirmé chez l'opérateur, mais notification perdue.
      const lost = await pay();
      app.get(SandboxGateway).simulate(lost.providerRef!, {
        status: 'SUCCEEDED',
        amount: 2500,
        currency: 'XOF',
      });
      await prisma.payment.update({
        where: { id: lost.id },
        data: { createdAt: new Date(Date.now() - 11 * 60_000) },
      });
      // Jamais confirmé depuis plus de 24 h.
      const abandoned = await pay();
      await prisma.payment.update({
        where: { id: abandoned.id },
        data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
      });
      // Récent : pas encore vérifié.
      const recent = await pay();

      const result = await run('payments-reconcile');
      expect(result).toMatchObject({
        ran: true,
        result: { checked: 2, settled: 1, expired: 1, errors: 0 },
      });
      const status = async (id: string) =>
        (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(lost.id)).toBe('SUCCEEDED');
      expect(await status(abandoned.id)).toBe('CANCELLED');
      expect(await status(recent.id)).toBe('PENDING');
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: lost.orderId } }))
          .paymentStatus,
      ).toBe('PAID');
    });

    it('purge les données techniques expirées, jamais les données métier', async () => {
      const old = new Date(Date.now() - 40 * 86_400_000);
      await prisma.realtimeEvent.create({
        data: {
          restaurantId: owner.restaurantId,
          type: 'ancien',
          payload: {},
          createdAt: old,
        },
      });
      const result = await run('maintenance');
      expect(
        (result as { result: { realtimeEvents: number } }).result
          .realtimeEvents,
      ).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.realtimeEvent.count({ where: { type: 'ancien' } }),
      ).toBe(0);
      expect(
        await prisma.order.count({
          where: { restaurantId: owner.restaurantId },
        }),
      ).toBeGreaterThan(0);
    });

    it('expose l’état des tâches et des files aux super-admins (ADM-09)', async () => {
      await api().get('/api/v1/admin/jobs').set(bearer(owner)).expect(403);
      const res = await api()
        .get('/api/v1/admin/jobs')
        .set(bearer(admin))
        .expect(200);
      expect(res.body.enabled).toBe(false); // désactivées en test : pilotées par les tests
      expect(res.body.jobs.map((j: { name: string }) => j.name)).toEqual([
        'notifications',
        'webhooks',
        'payments-reconcile',
        'subscriptions',
        'maintenance',
      ]);
      expect(
        res.body.jobs.find((j: { name: string }) => j.name === 'subscriptions')
          .lastRunAt,
      ).not.toBeNull();
      expect(res.body.queues).toHaveProperty('notificationsPending');
      await api()
        .post('/api/v1/admin/jobs/inconnue/run')
        .set(bearer(admin))
        .expect(404);
      const manual = await api()
        .post('/api/v1/admin/jobs/webhooks/run')
        .set(bearer(admin))
        .expect(200);
      expect(manual.body).toMatchObject({ job: 'webhooks', ran: true });
    });
  });
});
