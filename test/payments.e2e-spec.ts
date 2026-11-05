import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { STRIPE_CLIENT } from '../src/payments/gateways/stripe.gateway';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createMember,
  createTestApp,
  FakeSender,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

const WEBHOOK_SECRET = 'whsec_e2e_test_secret'; // cf. .env.test

/**
 * Faux client Stripe : les appels réseau sont simulés, mais la vérification
 * de signature des webhooks est celle du vrai SDK.
 */
function createFakeStripe() {
  const real = new Stripe('sk_test_dummy');
  const intents = new Map<string, Record<string, unknown>>();
  let counter = 0;
  return {
    intents,
    webhooks: real.webhooks,
    paymentIntents: {
      create: jest.fn((params: Record<string, unknown>) => {
        const id = `pi_test_${++counter}`;
        const intent = {
          id,
          object: 'payment_intent',
          status: 'requires_payment_method',
          amount: params.amount,
          amount_received: 0,
          currency: params.currency,
          client_secret: `${id}_secret_abc`,
          last_payment_error: null,
        };
        intents.set(id, intent);
        return Promise.resolve(intent);
      }),
      retrieve: jest.fn((id: string) => Promise.resolve(intents.get(id))),
      cancel: jest.fn((id: string) => {
        const intent = intents.get(id);
        if (intent) intent.status = 'canceled';
        return Promise.resolve(intent);
      }),
    },
    refunds: {
      create: jest.fn(() =>
        Promise.resolve({ id: `re_test_${++counter}`, status: 'succeeded' }),
      ),
    },
    accounts: {
      create: jest.fn(() => Promise.resolve({ id: 'acct_test_resto' })),
    },
    accountLinks: {
      create: jest.fn(() =>
        Promise.resolve({
          url: 'https://connect.stripe.com/setup/e/acct_test_resto',
          expires_at: 1_900_000_000,
        }),
      ),
    },
  };
}

describe('Paiements (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let other: Session;
  let staff: { accessToken: string };
  let itemId: string;
  let qrToken: string;
  const stripe = createFakeStripe();

  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/restaurants/${owner.restaurantId}`;
  const key = () => `pay-${randomUUID()}`;

  /** Crée une commande client de `quantity` × 5 000 XOF. */
  async function newOrder(quantity = 1) {
    const res = await api()
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', key())
      .send({
        mode: 'DINE_IN',
        qrToken,
        items: [{ menuItemId: itemId, quantity }],
      })
      .expect(201);
    return {
      id: res.body.order.id as string,
      token: res.body.trackingToken as string,
    };
  }

  const cash = (orderId: string, body: object, idem = key(), who = staff) =>
    api()
      .post(`${base()}/orders/${orderId}/payments/cash`)
      .set(bearer(who))
      .set('Idempotency-Key', idem)
      .send(body);

  const payOnline = (
    order: { id: string; token: string },
    body: object,
    idem = key(),
  ) =>
    api()
      .post(`/api/v1/public/orders/${order.id}/payments`)
      .set('X-Order-Token', order.token)
      .set('Idempotency-Key', idem)
      .send(body);

  const simulate = (paymentId: string, body: object) =>
    api()
      .post(`/api/v1/public/payments/${paymentId}/sandbox`)
      .send(body)
      .expect(200);

  const orderRow = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });

  function sendWebhook(event: object, secret = WEBHOOK_SECRET) {
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    return api()
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(payload);
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp(new FakeSender(), [
      { token: STRIPE_CLIENT, value: stripe },
    ]));
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'pay.owner@test.sn', 'Le Lagon');
    other = await registerOwner(app, 'pay.other@test.sn', 'Autre');
    staff = await createMember(
      app,
      prisma,
      'pay.staff@test.sn',
      owner.restaurantId,
    );

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
      .send({ name: 'Grillades' })
      .expect(201);
    itemId = (
      await api()
        .post(`${base()}/menu/items`)
        .set(bearer(owner))
        .send({ categoryId: category.body.id, name: 'Dibi', priceAmount: 5000 })
        .expect(201)
    ).body.id;
    const [table] = (
      await api()
        .post(`${base()}/tables/bulk`)
        .set(bearer(owner))
        .send({ prefix: 'P', from: 1, to: 1 })
        .expect(201)
    ).body;
    qrToken = (
      await api().get(`${base()}/tables/${table.id}/qr`).set(bearer(owner))
    ).body.url.split('/t/')[1];
  });

  afterAll(async () => {
    await app.close();
  });

  describe('espèces au comptoir', () => {
    it('encaisse, rend la monnaie et émet un reçu numéroté', async () => {
      const order = await newOrder();
      const idem = key();
      const res = await cash(order.id, { amountReceived: 10000 }, idem).expect(
        201,
      );
      expect(res.body.change).toBe(5000);
      expect(res.body.payment).toMatchObject({
        provider: 'CASH',
        status: 'SUCCEEDED',
        amount: 5000,
      });
      expect(await orderRow(order.id)).toMatchObject({
        paymentStatus: 'PAID',
        receiptNumber: 1,
      });

      // Rejeu : pas de double encaissement.
      const replay = await cash(
        order.id,
        { amountReceived: 10000 },
        idem,
      ).expect(201);
      expect(replay.body.payment.id).toBe(res.body.payment.id);
      const again = await cash(order.id, {}).expect(409);
      expect(again.body.code).toBe('ORDER_ALREADY_PAID');

      const receipt = await api()
        .get(`${base()}/orders/${order.id}/receipt`)
        .set(bearer(staff))
        .expect(200);
      expect(receipt.body).toMatchObject({
        receiptNumber: 'R-000001',
        total: 5000,
        restaurant: { name: 'Le Lagon' },
        payments: [{ method: 'CASH', amount: 5000 }],
      });
      await api()
        .get(`/api/v1/public/orders/${order.id}/receipt`)
        .set('X-Order-Token', order.token)
        .expect(200);
    });

    it('refuse une somme insuffisante ou supérieure au reste dû', async () => {
      const order = await newOrder();
      expect(
        (await cash(order.id, { amountReceived: 1000 }).expect(400)).body.code,
      ).toBe('INSUFFICIENT_CASH');
      expect(
        (await cash(order.id, { amount: 6000 }).expect(400)).body.code,
      ).toBe('AMOUNT_EXCEEDS_DUE');
      const receipt = await api()
        .get(`${base()}/orders/${order.id}/receipt`)
        .set(bearer(staff))
        .expect(409);
      expect(receipt.body.code).toBe('RECEIPT_NOT_AVAILABLE');
    });

    it('accepte une addition réglée en plusieurs fois', async () => {
      const order = await newOrder();
      await cash(order.id, { amount: 2000 }).expect(201);
      expect((await orderRow(order.id)).paymentStatus).toBe('PARTIALLY_PAID');
      await cash(order.id, { amount: 3000 }).expect(201);
      expect((await orderRow(order.id)).paymentStatus).toBe('PAID');
    });

    it('refuse de régler une commande annulée', async () => {
      const order = await newOrder();
      await api()
        .post(`/api/v1/public/orders/${order.id}/cancel`)
        .set('X-Order-Token', order.token)
        .send({})
        .expect(200);
      expect((await cash(order.id, {}).expect(409)).body.code).toBe(
        'ORDER_NOT_PAYABLE',
      );
    });
  });

  describe('mobile money (simulateur)', () => {
    it("valide le paiement sur notification de l'opérateur", async () => {
      const order = await newOrder();
      const failed = await payOnline(order, {
        method: 'MOBILE_MONEY',
        operator: 'WAVE',
        payerPhone: '+221771234567',
      }).expect(201);
      expect(failed.body).toMatchObject({
        provider: 'SANDBOX',
        status: 'PENDING',
        amount: 5000,
        redirectUrl: expect.stringContaining('/sandbox-pay/'),
      });
      expect((await orderRow(order.id)).paymentStatus).toBe('PENDING');

      await simulate(failed.body.paymentId, { outcome: 'FAILED' });
      expect((await orderRow(order.id)).paymentStatus).toBe('UNPAID');

      const retry = await payOnline(order, {
        method: 'MOBILE_MONEY',
        operator: 'ORANGE_MONEY',
      }).expect(201);
      await simulate(retry.body.paymentId, { outcome: 'SUCCEEDED' });
      // Notification rejouée : sans effet.
      await simulate(retry.body.paymentId, { outcome: 'SUCCEEDED' });

      const row = await orderRow(order.id);
      expect(row.paymentStatus).toBe('PAID');
      const summary = await api()
        .get(`/api/v1/public/orders/${order.id}/payments`)
        .set('X-Order-Token', order.token)
        .expect(200);
      expect(summary.body).toMatchObject({
        amountDue: 0,
        paymentStatus: 'PAID',
      });
      expect(
        summary.body.payments.map((p: { status: string }) => p.status),
      ).toEqual(['FAILED', 'SUCCEEDED']);
    });

    it("n'accepte pas un montant reçu incohérent", async () => {
      const order = await newOrder();
      const { body } = await payOnline(order, {
        method: 'MOBILE_MONEY',
      }).expect(201);
      const payment = await simulate(body.paymentId, {
        outcome: 'SUCCEEDED',
        amount: 100,
      });
      expect(payment.body.status).toBe('PENDING');
      expect((await orderRow(order.id)).paymentStatus).toBe('PENDING');
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'payments.amount_mismatch',
            entityId: body.paymentId,
          },
        }),
      ).toBe(1);
    });

    it('une nouvelle tentative annule la précédente', async () => {
      const order = await newOrder();
      const first = await payOnline(order, { method: 'MOBILE_MONEY' }).expect(
        201,
      );
      await payOnline(order, { method: 'MOBILE_MONEY' }).expect(201);
      const old = await prisma.payment.findUniqueOrThrow({
        where: { id: first.body.paymentId },
      });
      expect(old.status).toBe('CANCELLED');
    });

    it('exige le jeton de commande', async () => {
      const order = await newOrder();
      await api()
        .post(`/api/v1/public/orders/${order.id}/payments`)
        .set('X-Order-Token', 'faux')
        .set('Idempotency-Key', key())
        .send({ method: 'MOBILE_MONEY' })
        .expect(404);
    });
  });

  describe('carte bancaire (Stripe Connect)', () => {
    it('exige un compte Stripe connecté', async () => {
      const order = await newOrder();
      const res = await payOnline(order, { method: 'CARD' }).expect(409);
      expect(res.body.code).toBe('STRIPE_NOT_CONNECTED');
    });

    it('onboarde le restaurant (OWNER uniquement) et active les paiements via webhook', async () => {
      const body = {
        returnUrl: 'http://localhost:3001/stripe/retour',
        refreshUrl: 'http://localhost:3001/stripe/relance',
      };
      await api()
        .post(`${base()}/payments/stripe/onboarding`)
        .set(bearer(staff))
        .send(body)
        .expect(403);
      const link = await api()
        .post(`${base()}/payments/stripe/onboarding`)
        .set(bearer(owner))
        .send(body)
        .expect(201);
      expect(link.body.url).toContain('connect.stripe.com');

      await sendWebhook({
        id: 'evt_account_1',
        object: 'event',
        type: 'account.updated',
        data: {
          object: {
            id: 'acct_test_resto',
            object: 'account',
            charges_enabled: true,
          },
        },
      }).expect(200);
      const status = await api()
        .get(`${base()}/payments/stripe/status`)
        .set(bearer(owner))
        .expect(200);
      expect(status.body).toEqual({ connected: true, chargesEnabled: true });
    });

    it('crée un PaymentIntent avec commission et le valide par webhook', async () => {
      const order = await newOrder(2); // 10 000 XOF
      const res = await payOnline(order, { method: 'CARD' }).expect(201);
      expect(res.body).toMatchObject({
        provider: 'STRIPE',
        status: 'PENDING',
        clientSecret: expect.stringContaining('_secret_'),
      });
      expect(stripe.paymentIntents.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          amount: 10000,
          currency: 'xof',
          application_fee_amount: 250, // 2,5 %
          transfer_data: { destination: 'acct_test_resto' },
        }),
        { idempotencyKey: `payment-${res.body.paymentId}` },
      );

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: res.body.paymentId },
      });
      const event = {
        id: `evt_${randomUUID()}`,
        object: 'event',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: payment.providerRef,
            object: 'payment_intent',
            status: 'succeeded',
            amount: 10000,
            amount_received: 10000,
            currency: 'xof',
            last_payment_error: null,
          },
        },
      };
      await sendWebhook(event).expect(200);
      expect((await orderRow(order.id)).paymentStatus).toBe('PAID');

      // Même événement renvoyé par Stripe : traité une seule fois.
      const duplicate = await sendWebhook(event).expect(200);
      expect(duplicate.body).toEqual({ received: true, duplicate: true });
    });

    it('rejette une signature invalide', async () => {
      const res = await sendWebhook(
        {
          id: 'evt_x',
          object: 'event',
          type: 'payment_intent.succeeded',
          data: { object: {} },
        },
        'whsec_pirate',
      ).expect(400);
      expect(res.body.code).toBe('INVALID_SIGNATURE');
    });

    it('rapproche un paiement dont le webhook a été perdu', async () => {
      const order = await newOrder();
      const res = await payOnline(order, { method: 'CARD' }).expect(201);
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: res.body.paymentId },
      });
      Object.assign(stripe.intents.get(payment.providerRef!)!, {
        status: 'succeeded',
        amount_received: 5000,
      });
      const reconciled = await api()
        .post(`${base()}/payments/${payment.id}/reconcile`)
        .set(bearer(staff))
        .expect(200);
      expect(reconciled.body.status).toBe('SUCCEEDED');
      expect((await orderRow(order.id)).paymentStatus).toBe('PAID');
    });
  });

  describe('remboursements', () => {
    it('rembourse partiellement puis totalement, avec permission et audit', async () => {
      const order = await newOrder();
      const { body } = await cash(order.id, {}).expect(201);
      const paymentId = body.payment.id as string;
      const refund = (
        amount: number | undefined,
        who: { accessToken: string },
      ) =>
        api()
          .post(`${base()}/payments/${paymentId}/refunds`)
          .set(bearer(who))
          .send({ amount, reason: 'Plat froid' });

      await refund(1000, staff).expect(403);
      await refund(1000, owner).expect(201);
      expect((await orderRow(order.id)).paymentStatus).toBe(
        'PARTIALLY_REFUNDED',
      );

      const tooMuch = await refund(9000, owner).expect(400);
      expect(tooMuch.body).toMatchObject({
        code: 'REFUND_EXCEEDS_PAYMENT',
        details: { refundable: 4000 },
      });
      await refund(undefined, owner).expect(201);
      expect((await orderRow(order.id)).paymentStatus).toBe('REFUNDED');
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'payments.refund',
            restaurantId: owner.restaurantId,
          },
        }),
      ).toBe(2);
    });

    it('rembourse un paiement carte en reprenant les fonds au restaurant', async () => {
      const card = await prisma.payment.findFirstOrThrow({
        where: { provider: 'STRIPE', status: 'SUCCEEDED' },
      });
      await api()
        .post(`${base()}/payments/${card.id}/refunds`)
        .set(bearer(owner))
        .send({ amount: 2000, reason: 'Geste commercial' })
        .expect(201);
      expect(stripe.refunds.create).toHaveBeenLastCalledWith({
        payment_intent: card.providerRef,
        amount: 2000,
        reverse_transfer: true,
        refund_application_fee: true,
      });
    });

    it("isole les paiements d'un autre établissement", async () => {
      const payment = await prisma.payment.findFirstOrThrow({
        where: { restaurantId: owner.restaurantId },
      });
      await api()
        .post(
          `/api/v1/restaurants/${other.restaurantId}/payments/${payment.id}/refunds`,
        )
        .set(bearer(other))
        .send({ reason: 'Tentative' })
        .expect(404);
    });
  });

  it('diffuse les mises à jour de paiement en temps réel', async () => {
    const events = await api()
      .get(`${base()}/events`)
      .set(bearer(owner))
      .expect(200);
    expect(
      events.body.some(
        (e: { type: string }) => e.type === 'order.payment_updated',
      ),
    ).toBe(true);
  });
});
