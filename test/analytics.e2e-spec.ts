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
 * Jeu de données (TVA 18 % incluse) :
 *  - commande 1, sur place (client) : 2 × Thiéboudienne 3 500 + 1 Bissap 500 = 7 500, payée
 *  - commande 2, à emporter (staff) : 1 × Thiéboudienne = 3 500, payée
 *  - commande 3 : 1 Bissap, annulée par le client (exclue des ventes)
 */
describe('Analytics (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let staff: { accessToken: string };

  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/restaurants/${owner.restaurantId}`;
  const analytics = (path: string) =>
    api().get(`${base()}/analytics/${path}`).set(bearer(owner));

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'ana.owner@test.sn', 'Chez Ndeye');
    staff = await createMember(
      app,
      prisma,
      'ana.staff@test.sn',
      owner.restaurantId,
    );

    const send = (
      method: 'post' | 'put' | 'patch',
      path: string,
      body: object,
    ) => api()[method](`${base()}${path}`).set(bearer(owner)).send(body);

    await send('put', '/opening-hours', {
      hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        opensAt: '00:00',
        closesAt: '00:00',
      })),
    }).expect(200);
    await send('patch', '/tax', { taxEnabled: true, taxRateBp: 1800 }).expect(
      200,
    );

    const category = (await send('post', '/menu/categories', { name: 'Carte' }))
      .body;
    const item = async (
      name: string,
      priceAmount: number,
      costAmount?: number,
    ) =>
      (
        await send('post', '/menu/items', {
          categoryId: category.id,
          name,
          priceAmount,
          costAmount,
        }).expect(201)
      ).body.id as string;
    const thieb = await item('Thiéboudienne', 3500, 1500);
    const bissap = await item('Bissap', 500, 100);
    await item('Salade', 2000); // jamais vendue, sans coût

    const order = async (
      body: object,
      path = '/api/v1/public/orders',
      who?: Session,
    ) => {
      const req = api()
        .post(path)
        .set('Idempotency-Key', `ana-${randomUUID()}`);
      if (who) req.set(bearer(who));
      const res = await req.send(body).expect(201);
      return res.body as {
        id: string;
        order: { id: string };
        trackingToken: string;
      };
    };
    const cash = (orderId: string) =>
      api()
        .post(`${base()}/orders/${orderId}/payments/cash`)
        .set(bearer(owner))
        .set('Idempotency-Key', `cash-${randomUUID()}`)
        .send({})
        .expect(201);

    const o1 = await order({
      mode: 'TAKEAWAY',
      restaurantSlug: owner.slug,
      items: [
        { menuItemId: thieb, quantity: 2 },
        { menuItemId: bissap, quantity: 1 },
      ],
    });
    // Commande 1 « sur place » : on rattache le mode pour le test de ventilation.
    await prisma.order.update({
      where: { id: o1.order.id },
      data: { mode: 'DINE_IN' },
    });
    await cash(o1.order.id);

    const o2 = await order(
      { mode: 'TAKEAWAY', items: [{ menuItemId: thieb, quantity: 1 }] },
      `${base()}/orders`,
      owner,
    );
    await cash(o2.id);

    const o3 = await order({
      mode: 'TAKEAWAY',
      restaurantSlug: owner.slug,
      items: [{ menuItemId: bissap, quantity: 1 }],
    });
    await api()
      .post(`/api/v1/public/orders/${o3.order.id}/cancel`)
      .set('X-Order-Token', o3.trackingToken)
      .send({})
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('calcule le tableau de bord et la comparaison de périodes (ANA-01)', async () => {
    const res = await analytics('overview').expect(200);
    expect(res.body).toMatchObject({
      currency: 'XOF',
      revenue: 11000,
      orders: 2,
      averageBasket: 5500,
      cancelledOrders: 1,
      cancellationRate: 33.3,
      byMode: {
        DINE_IN: { orders: 1, revenue: 7500 },
        TAKEAWAY: { orders: 1, revenue: 3500 },
      },
      bySource: {
        CUSTOMER: { orders: 1, revenue: 7500 },
        STAFF: { orders: 1, revenue: 3500 },
      },
      comparison: { revenue: 0, revenueChange: null },
    });
    expect(res.body.peakHours).toHaveLength(24);
    expect(
      res.body.peakHours.reduce(
        (s: number, h: { orders: number }) => s + h.orders,
        0,
      ),
    ).toBe(2);
    // Série quotidienne continue sur la période par défaut (30 jours).
    expect(res.body.daily.length).toBeGreaterThanOrEqual(30);
    expect(res.body.daily.at(-1)).toMatchObject({ orders: 2, revenue: 11000 });
  });

  it('mesure la performance et la marge par plat (ANA-02)', async () => {
    const res = await analytics('menu').expect(200);
    const byName = Object.fromEntries(
      res.body.items.map((i: { name: string }) => [i.name, i]),
    );
    expect(byName['Thiéboudienne']).toMatchObject({
      quantity: 3,
      revenue: 10500,
      cost: 4500,
      margin: 6000,
      marginRate: 57.1,
    });
    // La commande annulée n'est pas comptée.
    expect(byName['Bissap']).toMatchObject({
      quantity: 1,
      revenue: 500,
      margin: 400,
    });
    expect(byName['Salade']).toMatchObject({
      quantity: 0,
      cost: null,
      margin: null,
    });
    expect(res.body.bestSellers[0].name).toBe('Thiéboudienne');
    expect(res.body.leastSold[0].name).toBe('Salade');
  });

  it('produit le récapitulatif de TVA des commandes encaissées (ANA-07)', async () => {
    const res = await analytics('tax').expect(200);
    // TVA extraite : 7 500 × 18/118 = 1 144 ; 3 500 × 18/118 = 534
    expect(res.body.totals).toMatchObject({
      orders: 2,
      taxAmount: 1678,
      baseAmount: 9322,
      totalInclTax: 11000,
      refunds: 0,
    });
    expect(res.body.lines[0]).toMatchObject({ taxRateBp: 1800 });

    const monthly = await analytics('tax')
      .query({ groupBy: 'month' })
      .expect(200);
    expect(monthly.body.lines[0].period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('exporte en CSV (ANA-04)', async () => {
    for (const [path, header] of [
      ['overview', 'date;commandes;chiffre_affaires'],
      ['menu', 'article;categorie;quantite'],
      ['tax', 'periode;taux_tva_pct;commandes'],
    ]) {
      const res = await analytics(path).query({ format: 'csv' }).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('.csv');
      expect(res.text.replace('﻿', '')).toMatch(new RegExp(`^${header}`));
    }
  });

  it('valide la période demandée', async () => {
    const reversed = await analytics('overview')
      .query({ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' })
      .expect(400);
    expect(reversed.body.code).toBe('INVALID_PERIOD');
    const tooLong = await analytics('overview')
      .query({ from: '2025-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' })
      .expect(400);
    expect(tooLong.body.code).toBe('PERIOD_TOO_LONG');
  });

  it('exige la permission reports.view', async () => {
    const res = await api()
      .get(`${base()}/analytics/overview`)
      .set(bearer(staff))
      .expect(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('est réservé aux forfaits incluant les analytics', async () => {
    await api()
      .post('/api/v1/billing/subscription/change')
      .set(bearer(owner))
      .send({ planCode: 'STARTER' })
      .expect(200);
    const res = await analytics('overview').expect(403);
    expect(res.body).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'analytics' },
    });
  });
});
