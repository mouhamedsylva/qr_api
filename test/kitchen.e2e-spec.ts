import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
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

/**
 * Routage :
 *  - catégorie « Plats » → poste Grill (Thiéboudienne, Salade héritent)
 *  - Bissap (catégorie Boissons, sans poste) → poste Bar au niveau de l'article
 *  - Pain (catégorie Divers, sans poste) → non routé
 */
describe('Cuisine — module 11 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let other: Session;
  let staff: { accessToken: string };
  let grill: string;
  let bar: string;
  const items: Record<string, string> = {};

  const api = () => request(app.getHttpServer());
  const base = (s: Session = owner) => `/api/v1/restaurants/${s.restaurantId}`;
  const send = (
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body: object = {},
    who: { accessToken: string } = owner,
  ) => api()[method](`${base()}${path}`).set(bearer(who)).send(body);
  const tickets = (query: Record<string, string> = {}) =>
    api().get(`${base()}/kitchen/tickets`).query(query).set(bearer(staff));

  async function newOrder(names: string[], accept = true) {
    const res = await api()
      .post(`${base()}/orders`)
      .set(bearer(owner))
      .set('Idempotency-Key', `kds-${randomUUID()}`)
      .send({
        mode: 'TAKEAWAY',
        items: names.map((n) => ({ menuItemId: items[n], quantity: 1 })),
      })
      .expect(201);
    if (accept)
      await send('patch', `/orders/${res.body.id}/status`, {
        status: 'ACCEPTED',
      }).expect(200);
    return res.body as {
      id: string;
      number: number;
      items: { id: string; name: string }[];
    };
  }

  const setPlan = async (email: string, code: string) => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code } });
    await prisma.subscription.updateMany({
      where: { user: { email } },
      data: { planId: plan.id },
    });
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'kds.owner@test.sn', 'Grill Dakar');
    other = await registerOwner(app, 'kds.other@test.sn', 'Concurrent');
    staff = await createMember(
      app,
      prisma,
      'kds.staff@test.sn',
      owner.restaurantId,
    );
    await setPlan('kds.owner@test.sn', 'PREMIUM');
    await setPlan('kds.other@test.sn', 'PREMIUM');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('postes et routage (KDS-02)', () => {
    it('gère les postes : lecture pour l’équipe, création réservée', async () => {
      await send('post', '/kitchen/stations', { name: 'Grill' }, staff).expect(
        403,
      );
      grill = (
        await send('post', '/kitchen/stations', {
          name: 'Grill',
          color: '#E4572E',
        }).expect(201)
      ).body.id;
      bar = (
        await send('post', '/kitchen/stations', { name: 'Bar' }).expect(201)
      ).body.id;
      const list = await api()
        .get(`${base()}/kitchen/stations`)
        .set(bearer(staff))
        .expect(200);
      expect(
        list.body.map((s: { name: string; position: number }) => [
          s.name,
          s.position,
        ]),
      ).toEqual([
        ['Grill', 0],
        ['Bar', 1],
      ]);
    });

    it('route par catégorie, avec surcharge par article', async () => {
      const foreign = (
        await api()
          .post(`${base(other)}/kitchen/stations`)
          .set(bearer(other))
          .send({ name: 'Poste étranger' })
          .expect(201)
      ).body.id;
      const refused = await send('post', '/menu/categories', {
        name: 'Volé',
        stationId: foreign,
      }).expect(400);
      expect(refused.body.code).toBe('INVALID_STATION');

      const plats = (
        await send('post', '/menu/categories', {
          name: 'Plats',
          stationId: grill,
        }).expect(201)
      ).body.id;
      const boissons = (
        await send('post', '/menu/categories', { name: 'Boissons' }).expect(201)
      ).body.id;
      const divers = (
        await send('post', '/menu/categories', { name: 'Divers' }).expect(201)
      ).body.id;
      const item = async (
        name: string,
        categoryId: string,
        stationId?: string,
      ) => {
        items[name] = (
          await send('post', '/menu/items', {
            categoryId,
            name,
            priceAmount: 1000,
            stationId,
          }).expect(201)
        ).body.id;
      };
      await item('Thiéboudienne', plats);
      await item('Salade', plats);
      await item('Bissap', boissons, bar);
      await item('Pain', divers);

      const order = await newOrder(
        ['Thiéboudienne', 'Bissap', 'Pain', 'Salade'],
        false,
      );
      const rows = await prisma.orderItem.findMany({
        where: { orderId: order.id },
      });
      const station = Object.fromEntries(
        rows.map((r) => [r.name, r.stationId]),
      );
      expect(station).toEqual({
        Thiéboudienne: grill,
        Salade: grill,
        Bissap: bar,
        Pain: null,
      });
      expect(rows.every((r) => r.kitchenStatus === 'PENDING')).toBe(true);
    });
  });

  describe('tickets et avancement (KDS-01)', () => {
    let order: Awaited<ReturnType<typeof newOrder>>;
    const itemId = (name: string) =>
      order.items.find((i) => i.name === name)!.id;

    it('n’affiche que les commandes acceptées, filtrées par poste', async () => {
      // La commande du test précédent est encore « en attente » : absente.
      expect((await tickets().expect(200)).body).toHaveLength(0);

      order = await newOrder(['Thiéboudienne', 'Bissap', 'Pain']);
      const grillTickets = (await tickets({ stationId: grill }).expect(200))
        .body;
      expect(grillTickets).toHaveLength(1);
      expect(grillTickets[0]).toMatchObject({
        number: order.number,
        urgency: 'normal',
        items: [
          {
            name: 'Thiéboudienne',
            kitchenStatus: 'PENDING',
            station: { name: 'Grill' },
          },
        ],
      });
      expect(
        (await tickets({ stationId: bar }).expect(200)).body[0].items.map(
          (i: { name: string }) => i.name,
        ),
      ).toEqual(['Bissap']);
      expect(
        (await tickets({ stationId: 'none' }).expect(200)).body[0].items.map(
          (i: { name: string }) => i.name,
        ),
      ).toEqual(['Pain']);
      expect((await tickets().expect(200)).body[0].items).toHaveLength(3);
      await tickets({ stationId: 'pas-un-uuid' }).expect(400);
    });

    it('passe la commande en préparation dès la première ligne lancée', async () => {
      const res = await send(
        'patch',
        `/kitchen/items/${itemId('Thiéboudienne')}`,
        { status: 'IN_PROGRESS' },
        staff,
      ).expect(200);
      expect(res.body.status).toBe('PREPARING');
      const invalid = await send(
        'patch',
        `/kitchen/items/${itemId('Thiéboudienne')}`,
        { status: 'PENDING' },
        staff,
      ).expect(409);
      expect(invalid.body.code).toBe('INVALID_TRANSITION');
    });

    it('« bump » un poste, puis passe la commande prête quand tout est prêt', async () => {
      const afterGrill = await send(
        'post',
        `/kitchen/orders/${order.id}/bump`,
        { stationId: grill },
        staff,
      ).expect(200);
      expect(afterGrill.body.status).toBe('PREPARING');
      // Ticket terminé pour le grill : masqué, sauf demande explicite.
      expect(
        (await tickets({ stationId: grill }).expect(200)).body,
      ).toHaveLength(0);
      expect(
        (await tickets({ stationId: grill, includeReady: 'true' }).expect(200))
          .body,
      ).toHaveLength(1);

      await send(
        'post',
        `/kitchen/orders/${order.id}/bump`,
        { stationId: bar },
        staff,
      ).expect(200);
      const done = await send(
        'post',
        `/kitchen/orders/${order.id}/bump`,
        { stationId: 'none' },
        staff,
      ).expect(200);
      expect(done.body.status).toBe('READY');
      expect(
        done.body.items.every(
          (i: { kitchenStatus: string }) => i.kitchenStatus === 'READY',
        ),
      ).toBe(true);

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(row.readyAt).not.toBeNull();
      // Le client est notifié (événement de commande, diffusé à sa salle).
      const event = await prisma.realtimeEvent.findFirst({
        where: { orderId: order.id, type: 'order.status_changed' },
        orderBy: { seq: 'desc' },
      });
      expect(event?.payload).toMatchObject({
        status: 'READY',
        previousStatus: 'PREPARING',
      });
      expect((await tickets().expect(200)).body).toHaveLength(0);

      // Une commande sortie de cuisine n'est plus modifiable depuis l'écran.
      const late = await send(
        'patch',
        `/kitchen/items/${itemId('Pain')}`,
        { status: 'IN_PROGRESS' },
        staff,
      ).expect(409);
      expect(late.body.code).toBe('ORDER_NOT_IN_KITCHEN');
    });

    it('refuse l’avancement d’une commande non acceptée', async () => {
      const pending = await newOrder(['Pain'], false);
      const res = await send(
        'patch',
        `/kitchen/items/${pending.items[0].id}`,
        { status: 'READY' },
        staff,
      ).expect(409);
      expect(res.body).toMatchObject({
        code: 'ORDER_NOT_IN_KITCHEN',
        details: { status: 'PENDING' },
      });
    });

    it('trie les tickets : prioritaires, en retard, puis plus anciens', async () => {
      const oldest = await newOrder(['Salade']);
      const late = await newOrder(['Salade']);
      const rush = await newOrder(['Salade']);
      await prisma.order.update({
        where: { id: late.id },
        data: { estimatedReadyAt: new Date(Date.now() - 60_000) },
      });
      await send(
        'patch',
        `/kitchen/orders/${rush.id}/rush`,
        { isRush: true },
        staff,
      ).expect(200);

      const list = (await tickets({ stationId: grill }).expect(200)).body as {
        orderId: string;
        urgency: string;
        isRush: boolean;
      }[];
      expect(list.map((t) => t.orderId)).toEqual([rush.id, late.id, oldest.id]);
      expect(list[1].urgency).toBe('late');
    });
  });

  describe('sécurité et forfait', () => {
    it('isole les lignes d’un autre établissement', async () => {
      const line = await prisma.orderItem.findFirstOrThrow({
        where: { order: { restaurantId: owner.restaurantId } },
      });
      await api()
        .patch(`${base(other)}/kitchen/items/${line.id}`)
        .set(bearer(other))
        .send({ status: 'READY' })
        .expect(404);
    });

    it('la suppression d’un poste dé-route ses catégories', async () => {
      await send('delete', `/kitchen/stations/${grill}`).expect(204);
      const plats = await prisma.category.findFirstOrThrow({
        where: { name: 'Plats' },
      });
      expect(plats.stationId).toBeNull();
    });

    it('est réservé au forfait incluant l’écran cuisine', async () => {
      await setPlan('kds.owner@test.sn', 'PRO');
      const res = await tickets().expect(403);
      expect(res.body).toMatchObject({
        code: 'FEATURE_NOT_IN_PLAN',
        details: { feature: 'kds' },
      });
    });
  });
});
