import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createMember,
  createTestApp,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

describe('Commandes & temps réel (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let other: Session;
  let staff: { accessToken: string };
  let port: number;

  // Données du menu
  let thiebId: string;
  let normalId: string;
  let largeId: string;
  let bissapId: string;
  // Tables
  let tableId: string;
  let tableQr: string;
  let counterQr: string;

  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/restaurants/${owner.restaurantId}`;
  const key = () => `test-${randomUUID()}`;

  /** Commande client sur place, via le QR de la table. */
  const customerOrder = (items: object[], idem = key()) =>
    api()
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', idem)
      .send({ mode: 'DINE_IN', qrToken: tableQr, items });

  const thieb = (qty = 1, optionId = normalId) => ({
    menuItemId: thiebId,
    quantity: qty,
    optionIds: [optionId],
  });
  const bissap = (qty: number) => ({ menuItemId: bissapId, quantity: qty });

  const setStatus = (
    orderId: string,
    status: string,
    reason?: string,
    who = owner as { accessToken: string },
  ) =>
    api()
      .patch(`${base()}/orders/${orderId}/status`)
      .set(bearer(who))
      .send({ status, reason });

  const tokenFromUrl = (url: string) => url.split('/t/')[1];

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    await app.listen(0);
    port = Number(new URL(await app.getUrl()).port);

    owner = await registerOwner(app, 'orders.owner@test.sn', 'Chez Fatou');
    other = await registerOwner(app, 'orders.other@test.sn', 'Ailleurs');
    staff = await createMember(
      app,
      prisma,
      'orders.staff@test.sn',
      owner.restaurantId,
    );

    // Ouvert 24 h/24 pour que les tests ne dépendent pas de l'heure.
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
    // TVA 18 % incluse dans les prix.
    await api()
      .patch(`${base()}/tax`)
      .set(bearer(owner))
      .send({ taxEnabled: true, taxRateBp: 1800, pricesIncludeTax: true })
      .expect(200);

    const category = await api()
      .post(`${base()}/menu/categories`)
      .set(bearer(owner))
      .send({ name: 'Plats' })
      .expect(201);
    const t = await api()
      .post(`${base()}/menu/items`)
      .set(bearer(owner))
      .send({
        categoryId: category.body.id,
        name: 'Thiéboudienne',
        priceAmount: 3500,
        prepTimeMinutes: 20,
        optionGroups: [
          {
            name: 'Taille',
            isRequired: true,
            options: [
              { name: 'Normale' },
              { name: 'Grande', priceDelta: 1000 },
            ],
          },
        ],
      })
      .expect(201);
    thiebId = t.body.id;
    [normalId, largeId] = t.body.optionGroups[0].options.map(
      (o: { id: string }) => o.id,
    );
    bissapId = (
      await api()
        .post(`${base()}/menu/items`)
        .set(bearer(owner))
        .send({
          categoryId: category.body.id,
          name: 'Bissap',
          priceAmount: 500,
        })
        .expect(201)
    ).body.id;
    await api()
      .patch(`${base()}/menu/items/${bissapId}/availability`)
      .set(bearer(owner))
      .send({ stockQuantity: 3 })
      .expect(200);

    const tables = await api()
      .post(`${base()}/tables/bulk`)
      .set(bearer(owner))
      .send({ prefix: 'T', from: 1, to: 2 })
      .expect(201);
    tableId = tables.body[0].id;
    tableQr = tokenFromUrl(
      (
        await api()
          .get(`${base()}/tables/${tableId}/qr`)
          .set(bearer(owner))
          .expect(200)
      ).body.url,
    );
    const counter = await api()
      .post(`${base()}/tables`)
      .set(bearer(owner))
      .send({ label: 'Comptoir', kind: 'COUNTER' })
      .expect(201);
    counterQr = tokenFromUrl(
      (
        await api()
          .get(`${base()}/tables/${counter.body.id}/qr`)
          .set(bearer(owner))
      ).body.url,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  describe('création par le client', () => {
    it("exige une clé d'idempotence", async () => {
      const res = await api()
        .post('/api/v1/public/orders')
        .send({ mode: 'DINE_IN', qrToken: tableQr, items: [thieb()] })
        .expect(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('crée une commande sur place avec des prix calculés côté serveur', async () => {
      const res = await customerOrder([thieb(2, largeId), bissap(1)]).expect(
        201,
      );
      const { order, trackingToken } = res.body;
      expect(trackingToken).toEqual(expect.any(String));
      expect(order).toMatchObject({
        number: 1,
        status: 'PENDING',
        mode: 'DINE_IN',
        table: { label: 'T1' },
        subtotal: 9500, // 2 × (3500 + 1000) + 500
        taxTotal: 1449, // 9500 × 1800 / 11800
        total: 9500,
        currency: 'XOF',
      });
      expect(order.items[0]).toMatchObject({
        name: 'Thiéboudienne',
        unitPrice: 4500,
        options: [{ groupName: 'Taille', name: 'Grande', priceDelta: 1000 }],
      });
      expect(order).not.toHaveProperty('idempotencyKey');
      expect(new Date(order.estimatedReadyAt).getTime()).toBeGreaterThan(
        Date.now() + 19 * 60_000,
      );

      const table = await prisma.diningTable.findUnique({
        where: { id: tableId },
      });
      expect(table?.status).toBe('ORDERING');
    });

    it('rejoue une requête sans créer de doublon (CMD-16)', async () => {
      const idem = key();
      const first = await customerOrder([thieb()], idem).expect(201);
      const replay = await customerOrder([thieb()], idem).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.order.id).toBe(first.body.order.id);
      expect(replay.body.trackingToken).toBe(first.body.trackingToken);
      expect(
        await prisma.order.count({ where: { idempotencyKey: idem } }),
      ).toBe(1);
    });

    it('impose le QR pour le sur place et le comptoir pour l’emporter', async () => {
      const noQr = await api()
        .post('/api/v1/public/orders')
        .set('Idempotency-Key', key())
        .send({ mode: 'DINE_IN', restaurantSlug: owner.slug, items: [thieb()] })
        .expect(400);
      expect(noQr.body.code).toBe('QR_REQUIRED');

      const counterDineIn = await api()
        .post('/api/v1/public/orders')
        .set('Idempotency-Key', key())
        .send({ mode: 'DINE_IN', qrToken: counterQr, items: [thieb()] })
        .expect(400);
      expect(counterDineIn.body.code).toBe('COUNTER_TAKEAWAY_ONLY');

      const takeaway = await api()
        .post('/api/v1/public/orders')
        .set('Idempotency-Key', key())
        .send({
          mode: 'TAKEAWAY',
          qrToken: counterQr,
          items: [thieb()],
          customerName: 'Ibrahima',
        })
        .expect(201);
      expect(takeaway.body.order).toMatchObject({
        mode: 'TAKEAWAY',
        table: null,
      });

      await api()
        .post('/api/v1/public/orders')
        .set('Idempotency-Key', key())
        .send({
          mode: 'TAKEAWAY',
          restaurantSlug: owner.slug,
          items: [thieb()],
        })
        .expect(201);
    });

    it('refuse un QR falsifié et des options invalides', async () => {
      await api()
        .post('/api/v1/public/orders')
        .set('Idempotency-Key', key())
        .send({ mode: 'DINE_IN', qrToken: `${tableQr}x`, items: [thieb()] })
        .expect(400);
      const res = await customerOrder([
        { menuItemId: thiebId, quantity: 1 },
      ]).expect(400);
      expect(res.body.code).toBe('INVALID_OPTIONS');
    });

    it('protège le suivi par le jeton de commande', async () => {
      const { body } = await customerOrder([thieb()]).expect(201);
      await api()
        .get(`/api/v1/public/orders/${body.order.id}`)
        .set('X-Order-Token', body.trackingToken)
        .expect(200);
      await api()
        .get(`/api/v1/public/orders/${body.order.id}`)
        .set('X-Order-Token', 'mauvais-jeton')
        .expect(404);
      await api().get(`/api/v1/public/orders/${body.order.id}`).expect(404);
    });
  });

  describe('stock et annulation client', () => {
    it('décrémente le stock, refuse le dépassement et le restaure à l’annulation', async () => {
      await prisma.menuItem.update({
        where: { id: bissapId },
        data: { stockQuantity: 3 },
      });
      const { body } = await customerOrder([bissap(2)]).expect(201);
      expect(
        (await prisma.menuItem.findUnique({ where: { id: bissapId } }))
          ?.stockQuantity,
      ).toBe(1);

      const res = await customerOrder([bissap(2)]).expect(409);
      expect(res.body.code).toBe('OUT_OF_STOCK');

      await api()
        .post(`/api/v1/public/orders/${body.order.id}/cancel`)
        .set('X-Order-Token', body.trackingToken)
        .send({})
        .expect(200);
      expect(
        (await prisma.menuItem.findUnique({ where: { id: bissapId } }))
          ?.stockQuantity,
      ).toBe(3);
    });

    it('le client ne peut plus annuler une commande acceptée', async () => {
      const { body } = await customerOrder([thieb()]).expect(201);
      await setStatus(body.order.id, 'ACCEPTED').expect(200);
      const res = await api()
        .post(`/api/v1/public/orders/${body.order.id}/cancel`)
        .set('X-Order-Token', body.trackingToken)
        .send({})
        .expect(409);
      expect(res.body.code).toBe('CANNOT_CANCEL');
    });
  });

  describe('workflow et commandes additionnelles', () => {
    it('applique les transitions, motifs et permissions', async () => {
      const { body } = await customerOrder([thieb()]).expect(201);
      const id = body.order.id;

      const invalid = await setStatus(id, 'READY').expect(409);
      expect(invalid.body.code).toBe('INVALID_TRANSITION');

      // Le staff fait avancer la commande mais ne peut pas l'annuler.
      await setStatus(id, 'ACCEPTED', undefined, staff).expect(200);
      await setStatus(id, 'CANCELLED', 'Rupture', staff).expect(403);

      const noReason = await setStatus(id, 'CANCELLED').expect(400);
      expect(noReason.body.code).toBe('REASON_REQUIRED');
      const cancelled = await setStatus(id, 'CANCELLED', 'Client parti').expect(
        200,
      );
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Client parti',
        cancelledBy: 'STAFF',
      });
      const log = await prisma.auditLog.findFirst({
        where: { action: 'orders.cancel', entityId: id },
      });
      expect(log).not.toBeNull();
    });

    it('ajoute des articles à une commande prête et la renvoie en cuisine', async () => {
      const { body } = await customerOrder([thieb()]).expect(201);
      const id = body.order.id;
      await setStatus(id, 'ACCEPTED').expect(200);
      await setStatus(id, 'READY').expect(200);

      const idem = key();
      const add = () =>
        api()
          .post(`/api/v1/public/orders/${id}/items`)
          .set('X-Order-Token', body.trackingToken)
          .set('Idempotency-Key', idem)
          .send({ items: [thieb(1, largeId)] });
      const res = await add().expect(201);
      expect(res.body).toMatchObject({
        status: 'ACCEPTED',
        subtotal: 8000,
        total: 8000,
      });
      expect(res.body.items.map((i: { batch: number }) => i.batch)).toEqual([
        1, 2,
      ]);

      // Rejeu : pas de doublon.
      const replay = await add().expect(201);
      expect(replay.body.items).toHaveLength(2);
    });

    it('clôture la commande et passe la table « à nettoyer »', async () => {
      // Termine toutes les commandes encore actives de la table T1.
      const active = await prisma.order.findMany({
        where: {
          tableId,
          status: {
            in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'],
          },
        },
      });
      for (const order of active) {
        if (order.status === 'PENDING') {
          await setStatus(order.id, 'ACCEPTED').expect(200);
        }
        if (['PENDING', 'ACCEPTED', 'PREPARING'].includes(order.status)) {
          await setStatus(order.id, 'READY').expect(200);
        }
        await setStatus(order.id, 'COMPLETED').expect(200);
      }
      const table = await prisma.diningTable.findUnique({
        where: { id: tableId },
      });
      expect(table?.status).toBe('TO_CLEAN');
    });
  });

  describe('règles de l’établissement', () => {
    it('bloque les clients hors horaires mais pas le staff', async () => {
      const now = Date.now();
      const closure = await api()
        .post(`${base()}/closures`)
        .set(bearer(owner))
        .send({
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 3_600_000).toISOString(),
        })
        .expect(201);

      const res = await customerOrder([thieb()]).expect(409);
      expect(res.body.code).toBe('RESTAURANT_CLOSED');

      const staffOrder = await api()
        .post(`${base()}/orders`)
        .set(bearer(staff))
        .set('Idempotency-Key', key())
        .send({
          mode: 'TAKEAWAY',
          items: [thieb()],
          customerName: 'Sans smartphone',
        })
        .expect(201);
      expect(staffOrder.body).toMatchObject({ source: 'STAFF' });

      await api()
        .delete(`${base()}/closures/${closure.body.id}`)
        .set(bearer(owner))
        .expect(204);
    });

    it('exige une table pour une saisie staff sur place', async () => {
      const res = await api()
        .post(`${base()}/orders`)
        .set(bearer(staff))
        .set('Idempotency-Key', key())
        .send({ mode: 'DINE_IN', items: [thieb()] })
        .expect(400);
      expect(res.body.code).toBe('TABLE_REQUIRED');
    });
  });

  describe('historique, export et dashboard', () => {
    it('filtre, recherche et pagine', async () => {
      const cancelled = await api()
        .get(`${base()}/orders`)
        .query({ status: 'CANCELLED,REJECTED' })
        .set(bearer(owner))
        .expect(200);
      expect(cancelled.body.meta.total).toBe(2);

      const byNumber = await api()
        .get(`${base()}/orders`)
        .query({ search: '1' })
        .set(bearer(owner))
        .expect(200);
      expect(
        byNumber.body.data.some((o: { number: number }) => o.number === 1),
      ).toBe(true);

      const staffOrders = await api()
        .get(`${base()}/orders`)
        .query({ source: 'STAFF', limit: 1 })
        .set(bearer(staff))
        .expect(200);
      expect(staffOrders.body.meta.total).toBe(1);
    });

    it('exporte en CSV', async () => {
      const res = await api()
        .get(`${base()}/orders/export.csv`)
        .set(bearer(owner))
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.replace('﻿', '').split('\r\n');
      expect(lines[0]).toContain('numero;date;mode');
      expect(lines.length).toBeGreaterThan(5);
    });

    it("isole les commandes d'un autre établissement", async () => {
      const order = await prisma.order.findFirst({
        where: { restaurantId: owner.restaurantId },
      });
      await api()
        .get(`/api/v1/restaurants/${other.restaurantId}/orders/${order!.id}`)
        .set(bearer(other))
        .expect(404);
      const list = await api()
        .get(`/api/v1/restaurants/${other.restaurantId}/orders`)
        .set(bearer(other))
        .expect(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('alimente le tableau de bord', async () => {
      const res = await api()
        .get(`${base()}/dashboard`)
        .set(bearer(owner))
        .expect(200);
      const expected = await prisma.order.aggregate({
        where: {
          restaurantId: owner.restaurantId,
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
        _sum: { total: true },
        _count: true,
      });
      expect(res.body).toMatchObject({
        salesTotal: expected._sum.total,
        ordersCount: expected._count,
        isOpen: true,
      });
      expect(res.body.ordersInProgress).toBeGreaterThan(0);
    });
  });

  describe('temps réel (Socket.IO)', () => {
    const sockets: Socket[] = [];
    const connect = (auth: object) => {
      const socket = io(`http://127.0.0.1:${port}/realtime`, {
        auth,
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      return socket;
    };
    const next = <T>(socket: Socket, event: string) =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout ${event}`)),
          5000,
        );
        socket.once(event, (data: T) => {
          clearTimeout(timer);
          resolve(data);
        });
      });

    afterAll(() => sockets.forEach((s) => s.disconnect()));

    it("diffuse les commandes à l'équipe et le suivi au client", async () => {
      const kitchen = connect({ token: staff.accessToken });
      await next(kitchen, 'connect');
      const ack = await kitchen.emitWithAck('subscribe', {
        restaurantId: owner.restaurantId,
      });
      expect(ack).toMatchObject({ ok: true, lastSeq: expect.any(Number) });

      const created = next<{ seq: number; payload: { id: string } }>(
        kitchen,
        'order.created',
      );
      const { body } = await customerOrder([thieb()]).expect(201);
      const event = await created;
      expect(event.payload.id).toBe(body.order.id);

      const customer = connect({
        orderId: body.order.id,
        orderToken: body.trackingToken,
      });
      await next(customer, 'connect');

      const customerEvent = next<{
        payload: Record<string, unknown>;
      }>(customer, 'order.status_changed');
      await setStatus(body.order.id, 'ACCEPTED').expect(200);
      const update = await customerEvent;
      expect(update.payload).toMatchObject({
        id: body.order.id,
        status: 'ACCEPTED',
      });
      expect(update.payload).not.toHaveProperty('idempotencyKey');

      // Rattrapage après reconnexion (NOT-06).
      const missed = await api()
        .get(`${base()}/events`)
        .query({ after: event.seq })
        .set(bearer(staff))
        .expect(200);
      expect(missed.body[0]).toMatchObject({
        type: 'order.status_changed',
        orderId: body.order.id,
      });
    });

    it("refuse l'abonnement à un autre établissement et les jetons invalides", async () => {
      const intruder = connect({ token: other.accessToken });
      await next(intruder, 'connect');
      const ack = await intruder.emitWithAck('subscribe', {
        restaurantId: owner.restaurantId,
      });
      expect(ack).toEqual({ ok: false, error: 'FORBIDDEN' });

      const forged = connect({ orderId: randomUUID(), orderToken: 'faux' });
      const error = await next<Error>(forged, 'connect_error');
      expect(error.message).toBe('UNAUTHORIZED');

      const expired = connect({ token: 'pas.un.jwt' });
      await next(expired, 'connect_error');
    });

    it('diffuse les changements de statut de table', async () => {
      const room = connect({ token: owner.accessToken });
      await next(room, 'connect');
      expect(
        await room.emitWithAck('subscribe', {
          restaurantId: owner.restaurantId,
        }),
      ).toMatchObject({ ok: true });
      const updated = next<{ payload: { id: string; status: string } }>(
        room,
        'table.updated',
      );
      await api()
        .patch(`${base()}/tables/${tableId}/status`)
        .set(bearer(staff))
        .send({ status: 'FREE' })
        .expect(200);
      expect((await updated).payload).toMatchObject({
        id: tableId,
        status: 'FREE',
      });
    });
  });
});
