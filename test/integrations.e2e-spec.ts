import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  MAX_ATTEMPTS,
  verifyWebhookSignature,
} from '../src/integrations/integrations.rules';
import { WebhooksService } from '../src/integrations/webhooks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createMember,
  createTestApp,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Faux système tiers : enregistre les webhooks reçus, statut de réponse réglable. */
function createReceiver() {
  const received: Received[] = [];
  const state = { status: 200 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(state.status).end();
    });
  });
  return { server, received, state };
}

describe('Intégrations — module 13 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let webhooks: WebhooksService;
  let owner: Session;
  let other: Session;
  let staff: { accessToken: string };
  let itemId: string;
  const receiver = createReceiver();
  let receiverUrl: string;

  const api = () => request(app.getHttpServer());
  const base = (s: Session = owner) => `/api/v1/restaurants/${s.restaurantId}`;
  const manage = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    who: { accessToken: string } = owner,
  ) => api()[method](`${base()}/integrations${path}`).set(bearer(who));
  const publicApi = (method: 'get' | 'patch', path: string, key?: string) => {
    const req = api()[method](`/api/v1/integrations${path}`);
    return key ? req.set('X-Api-Key', key) : req;
  };
  const setPlan = async (email: string, code: string) => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code } });
    await prisma.subscription.updateMany({
      where: { user: { email } },
      data: { planId: plan.id },
    });
  };
  const newOrder = async () =>
    (
      await api()
        .post(`${base()}/orders`)
        .set(bearer(owner))
        .set('Idempotency-Key', `int-${randomUUID()}`)
        .send({
          mode: 'TAKEAWAY',
          items: [{ menuItemId: itemId, quantity: 1 }],
        })
        .expect(201)
    ).body as { id: string; number: number };

  /** Attend que le récepteur ait reçu `count` requêtes (envoi asynchrone). */
  async function waitForDeliveries(count: number) {
    for (let i = 0; i < 100 && receiver.received.length < count; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(receiver.received.length).toBeGreaterThanOrEqual(count);
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      receiver.server.listen(0, '127.0.0.1', resolve),
    );
    receiverUrl = `http://127.0.0.1:${(receiver.server.address() as AddressInfo).port}/hooks`;

    ({ app, prisma } = await createTestApp());
    webhooks = app.get(WebhooksService);
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'int.owner@test.sn', 'Teranga POS');
    other = await registerOwner(app, 'int.other@test.sn', 'Voisin');
    staff = await createMember(
      app,
      prisma,
      'int.staff@test.sn',
      owner.restaurantId,
    );
    await setPlan('int.owner@test.sn', 'PREMIUM');

    const category = await api()
      .post(`${base()}/menu/categories`)
      .set(bearer(owner))
      .send({ name: 'Carte' });
    itemId = (
      await api()
        .post(`${base()}/menu/items`)
        .set(bearer(owner))
        .send({
          categoryId: category.body.id,
          name: 'Yassa',
          priceAmount: 3000,
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => receiver.server.close(resolve));
  });

  describe('clés d’API et API publique (INT-01)', () => {
    let readKey: string;
    let writeKey: string;

    it('réserve la gestion au forfait et aux rôles autorisés', async () => {
      const notPremium = await api()
        .get(`${base(other)}/integrations/api-keys`)
        .set(bearer(other))
        .expect(403);
      expect(notPremium.body.code).toBe('FEATURE_NOT_IN_PLAN');
      await manage('get', '/api-keys', staff).expect(403);
    });

    it('ne montre la clé qu’une seule fois', async () => {
      const res = await manage('post', '/api-keys')
        .send({ name: 'Caisse', scopes: ['menu:read', 'orders:read'] })
        .expect(201);
      readKey = res.body.key;
      expect(readKey).toMatch(new RegExp(`^${res.body.prefix}_`));
      writeKey = (
        await manage('post', '/api-keys')
          .send({ name: 'ERP', scopes: ['orders:read', 'orders:write'] })
          .expect(201)
      ).body.key;

      const list = await manage('get', '/api-keys').expect(200);
      expect(list.body).toHaveLength(2);
      expect(JSON.stringify(list.body)).not.toContain(readKey);
      expect(list.body[0]).not.toHaveProperty('keyHash');
      await manage('post', '/api-keys')
        .send({ name: 'X', scopes: ['admin:all'] })
        .expect(400);
    });

    it('authentifie par clé et limite aux droits accordés', async () => {
      expect((await publicApi('get', '/me').expect(401)).body.code).toBe(
        'INVALID_API_KEY',
      );
      await publicApi(
        'get',
        '/me',
        'qro_00000000_inventeinventeinventeinventeinvent',
      ).expect(401);

      const me = await publicApi('get', '/me', readKey).expect(200);
      expect(me.body).toMatchObject({
        restaurant: { id: owner.restaurantId, name: 'Teranga POS' },
        scopes: ['menu:read', 'orders:read'],
      });
      expect(me.headers['x-ratelimit-limit']).toBe('120');

      const menu = await publicApi('get', '/menu', readKey).expect(200);
      expect(menu.body.categories[0].items[0]).toMatchObject({
        name: 'Yassa',
        priceAmount: 3000,
      });

      const order = await newOrder();
      const list = await publicApi('get', '/orders', readKey).expect(200);
      expect(list.body.data.map((o: { id: string }) => o.id)).toContain(
        order.id,
      );
      await publicApi('get', `/orders/${order.id}`, readKey).expect(200);

      const denied = await publicApi(
        'patch',
        `/orders/${order.id}/status`,
        readKey,
      )
        .send({ status: 'ACCEPTED' })
        .expect(403);
      expect(denied.body).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        details: { missing: ['orders:write'] },
      });
      await publicApi('get', '/menu', writeKey).expect(403);

      const updated = await publicApi(
        'patch',
        `/orders/${order.id}/status`,
        writeKey,
      )
        .send({ status: 'ACCEPTED' })
        .expect(200);
      expect(updated.body.status).toBe('ACCEPTED');
    });

    it('n’expose jamais les données d’un autre établissement', async () => {
      const foreign = await prisma.order.create({
        data: {
          restaurantId: other.restaurantId,
          number: 1,
          mode: 'TAKEAWAY',
          source: 'STAFF',
          idempotencyKey: `foreign-${randomUUID()}`,
          currency: 'XOF',
          subtotal: 100,
          taxTotal: 0,
          serviceFee: 0,
          total: 100,
          taxRateBp: 0,
          pricesIncludeTax: true,
          serviceFeeBp: 0,
        },
      });
      await publicApi('get', `/orders/${foreign.id}`, readKey).expect(404);
    });

    it('applique un quota par clé', async () => {
      const key = (
        await manage('post', '/api-keys').send({
          name: 'Quota',
          scopes: ['menu:read'],
        })
      ).body.key;
      for (let i = 0; i < 120; i++)
        await publicApi('get', '/me', key).expect(200);
      const limited = await publicApi('get', '/me', key).expect(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Le quota est propre à chaque clé.
      await publicApi('get', '/me', readKey).expect(200);
    });

    it('coupe l’accès à la révocation, à l’expiration et hors forfait', async () => {
      const expired = (
        await manage('post', '/api-keys')
          .send({
            name: 'Expirée',
            scopes: ['menu:read'],
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          })
          .expect(201)
      ).body.key;
      await publicApi('get', '/me', expired).expect(401);

      const keys = await manage('get', '/api-keys').expect(200);
      const erp = keys.body.find((k: { name: string }) => k.name === 'ERP');
      await manage('delete', `/api-keys/${erp.id}`).expect(204);
      await publicApi('get', '/me', writeKey).expect(401);

      await setPlan('int.owner@test.sn', 'PRO');
      await publicApi('get', '/me', readKey).expect(401);
      await setPlan('int.owner@test.sn', 'PREMIUM');
      await publicApi('get', '/me', readKey).expect(200);
    });
  });

  describe('webhooks sortants (INT-02)', () => {
    let endpointId: string;
    let secret: string;

    it('enregistre un destinataire et ne montre le secret qu’une fois', async () => {
      await manage('post', '/webhooks')
        .send({ url: 'ftp://exemple.sn', events: ['order.created'] })
        .expect(400);
      await manage('post', '/webhooks')
        .send({ url: receiverUrl, events: ['commande.inventee'] })
        .expect(400);

      const res = await manage('post', '/webhooks')
        .send({
          url: receiverUrl,
          events: ['order.created', 'order.status_changed'],
          description: 'Caisse',
        })
        .expect(201);
      endpointId = res.body.id;
      secret = res.body.secret;
      expect(secret).toMatch(/^whsec_/);
      const list = await manage('get', '/webhooks').expect(200);
      expect(list.body[0]).not.toHaveProperty('secret');
    });

    it('envoie un webhook signé à chaque événement abonné', async () => {
      receiver.received.length = 0;
      const order = await newOrder();
      await waitForDeliveries(1);

      const [hit] = receiver.received;
      expect(hit.headers['x-qrorder-event']).toBe('order.created');
      expect(
        verifyWebhookSignature(
          secret,
          hit.body,
          String(hit.headers['x-qrorder-signature']),
        ),
      ).toBe(true);
      expect(
        verifyWebhookSignature(
          'whsec_faux',
          hit.body,
          String(hit.headers['x-qrorder-signature']),
        ),
      ).toBe(false);
      const body = JSON.parse(hit.body);
      expect(body).toMatchObject({
        type: 'order.created',
        restaurantId: owner.restaurantId,
        orderId: order.id,
        data: { id: order.id, number: order.number },
      });
      expect(body.id).toBe(hit.headers['x-qrorder-delivery']);

      // Événement non abonné : aucun envoi.
      await api()
        .post(`${base()}/orders/${order.id}/payments/cash`)
        .set(bearer(owner))
        .set('Idempotency-Key', `cash-${randomUUID()}`)
        .send({})
        .expect(201);
      expect(
        await prisma.webhookDelivery.count({
          where: { eventType: 'order.payment_updated' },
        }),
      ).toBe(0);
    });

    it('retente avec un délai croissant puis abandonne', async () => {
      receiver.received.length = 0;
      receiver.state.status = 500;
      await newOrder();
      await waitForDeliveries(1);
      await new Promise((r) => setTimeout(r, 100)); // laisse l'échec s'enregistrer

      const failed = await prisma.webhookDelivery.findFirstOrThrow({
        where: { endpointId },
        orderBy: { createdAt: 'desc' },
      });
      expect(failed).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastStatusCode: 500,
      });
      const delay = failed.nextAttemptAt.getTime() - Date.now();
      expect(delay).toBeGreaterThan(50_000); // ~1 min
      expect(delay).toBeLessThanOrEqual(60_000);

      // Pas encore dû : le traitement planifié l'ignore.
      expect(await webhooks.processDue()).toBe(0);

      // Échéance atteinte, destinataire rétabli : livré à la 2e tentative.
      receiver.state.status = 200;
      await prisma.webhookDelivery.update({
        where: { id: failed.id },
        data: { nextAttemptAt: new Date() },
      });
      expect(await webhooks.processDue()).toBe(1);
      expect(
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: failed.id },
        }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
      });

      // Dernière tentative en échec : abandon et compteur d'échecs du destinataire.
      receiver.state.status = 503;
      const last = await prisma.webhookDelivery.create({
        data: {
          endpointId,
          eventType: 'order.created',
          payload: {},
          attempts: MAX_ATTEMPTS - 1,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });
      await webhooks.processDue();
      expect(
        await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: last.id },
        }),
      ).toMatchObject({
        status: 'FAILED',
        attempts: MAX_ATTEMPTS,
      });
      expect(
        (
          await prisma.webhookEndpoint.findUniqueOrThrow({
            where: { id: endpointId },
          })
        ).failureCount,
      ).toBe(1);
      receiver.state.status = 200;
    });

    it('permet de tester, consulter, renvoyer et changer de secret', async () => {
      const ping = await manage('post', `/webhooks/${endpointId}/test`).expect(
        200,
      );
      expect(ping.body).toMatchObject({
        eventType: 'ping',
        status: 'SUCCEEDED',
        attempts: 1,
      });

      const history = await manage(
        'get',
        `/webhooks/${endpointId}/deliveries`,
      ).expect(200);
      expect(history.body.meta.total).toBeGreaterThanOrEqual(4);

      const again = await manage(
        'post',
        `/webhooks/deliveries/${ping.body.id}/redeliver`,
      ).expect(200);
      expect(again.body.id).not.toBe(ping.body.id);

      const rotated = await manage(
        'post',
        `/webhooks/${endpointId}/rotate-secret`,
      ).expect(200);
      receiver.received.length = 0;
      await manage('post', `/webhooks/${endpointId}/test`).expect(200);
      const sig = String(receiver.received[0].headers['x-qrorder-signature']);
      expect(
        verifyWebhookSignature(
          rotated.body.secret,
          receiver.received[0].body,
          sig,
        ),
      ).toBe(true);
      expect(
        verifyWebhookSignature(secret, receiver.received[0].body, sig),
      ).toBe(false);
    });

    it('n’envoie plus rien à un destinataire désactivé', async () => {
      await manage('patch', `/webhooks/${endpointId}`)
        .send({ isActive: false })
        .expect(200);
      const before = await prisma.webhookDelivery.count();
      await newOrder();
      expect(await prisma.webhookDelivery.count()).toBe(before);
    });

    it('isole les destinataires entre établissements', async () => {
      await setPlan('int.other@test.sn', 'PREMIUM');
      await api()
        .post(`${base(other)}/integrations/webhooks/${endpointId}/test`)
        .set(bearer(other))
        .expect(404);
    });
  });

  describe('liens et export comptable (INT-04, INT-06)', () => {
    it('fournit les liens à publier', async () => {
      const res = await api()
        .get(`${base()}/integrations/links`)
        .set(bearer(staff))
        .expect(200);
      expect(res.body.menuUrl).toBe(`http://localhost:5173/r/${owner.slug}`);
      expect(res.body.orderUrl).toContain('mode=takeaway');
    });

    it('exporte le journal des ventes et des remboursements', async () => {
      const payment = await prisma.payment.findFirstOrThrow({
        where: { restaurantId: owner.restaurantId },
      });
      await api()
        .post(`${base()}/payments/${payment.id}/refunds`)
        .set(bearer(owner))
        .send({ amount: 1000, reason: 'Plat manquant' })
        .expect(201);

      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const res = await api()
        .get(`${base()}/integrations/accounting-export.csv`)
        .query({ from, to })
        .set(bearer(owner))
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.replace('﻿', '').split('\r\n');
      expect(lines[0]).toBe(
        'date;type;piece;commande;montant_ht;tva;montant_ttc;frais_service;pourboire;moyens_paiement;devise;motif',
      );
      expect(lines.find((l) => l.includes(';VENTE;'))).toMatch(
        /;VENTE;R-000001;\d+;3000;0;3000;0;0;CASH;XOF;$/,
      );
      expect(lines.find((l) => l.includes(';REMBOURSEMENT;'))).toMatch(
        /;-1000;;;CASH;XOF;Plat manquant$/,
      );

      await api()
        .get(`${base()}/integrations/accounting-export.csv`)
        .query({ from: to, to: from })
        .set(bearer(owner))
        .expect(400);
    });
  });
});
