import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createMember,
  createTestApp,
  PASSWORD,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

interface Token {
  accessToken: string;
}

/** Prix : Thiéboudienne 3 500, Bissap 500, Jus 1 000 — TVA désactivée. */
describe('Expérience client — module 10 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let staff: Token;
  let awa: Token; // cliente avec compte
  let moussa: Token; // autre client
  let thieb: string;
  let bissap: string;
  let jus: string;

  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/restaurants/${owner.restaurantId}`;
  const send = (
    method: 'post' | 'put' | 'patch',
    path: string,
    body: object,
    who: Token = owner,
  ) => api()[method](`${base()}${path}`).set(bearer(who)).send(body);

  /** Commande à emporter ; `who` = client connecté (facultatif). */
  const order = (items: object[], extra: object = {}, who?: Token) => {
    const req = api()
      .post('/api/v1/public/orders')
      .set('Idempotency-Key', `cx-${randomUUID()}`);
    if (who) req.set(bearer(who));
    return req.send({
      mode: 'TAKEAWAY',
      restaurantSlug: owner.slug,
      items,
      ...extra,
    });
  };
  const quote = (items: object[], extra: object = {}, who?: Token) => {
    const req = api().post('/api/v1/public/orders/quote');
    if (who) req.set(bearer(who));
    return req.send({
      mode: 'TAKEAWAY',
      restaurantSlug: owner.slug,
      items,
      ...extra,
    });
  };
  const line = (menuItemId: string, quantity = 1) => ({ menuItemId, quantity });
  const cash = (orderId: string) =>
    api()
      .post(`${base()}/orders/${orderId}/payments/cash`)
      .set(bearer(staff))
      .set('Idempotency-Key', `cash-${randomUUID()}`)
      .send({})
      .expect(201);
  const setStatus = (orderId: string, status: string) =>
    api()
      .patch(`${base()}/orders/${orderId}/status`)
      .set(bearer(owner))
      .send({ status, reason: 'Test' })
      .expect(200);
  const registerCustomer = async (email: string, firstName: string) =>
    (
      await api()
        .post('/api/v1/auth/customers/register')
        .send({
          email,
          password: PASSWORD,
          firstName,
          lastName: 'Client',
          acceptTerms: true,
        })
        .expect(201)
    ).body.tokens as Token;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'cx.owner@test.sn', 'Le Baobab');
    staff = await createMember(
      app,
      prisma,
      'cx.staff@test.sn',
      owner.restaurantId,
    );
    await send('put', '/opening-hours', {
      hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        opensAt: '00:00',
        closesAt: '00:00',
      })),
    }).expect(200);
    const category = (await send('post', '/menu/categories', { name: 'Carte' }))
      .body;
    const item = async (name: string, priceAmount: number) =>
      (
        await send('post', '/menu/items', {
          categoryId: category.id,
          name,
          priceAmount,
        }).expect(201)
      ).body.id as string;
    thieb = await item('Thiéboudienne', 3500);
    bissap = await item('Bissap', 500);
    jus = await item('Jus de bouye', 1000);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('compte client (CLI-01)', () => {
    it('crée un compte client sans établissement', async () => {
      awa = await registerCustomer('awa.client@test.sn', 'Awa');
      moussa = await registerCustomer('moussa.client@test.sn', 'Moussa');
      const me = await api()
        .get('/api/v1/auth/me')
        .set(bearer(awa))
        .expect(200);
      expect(me.body).toMatchObject({ firstName: 'Awa', restaurants: [] });

      await api()
        .post('/api/v1/auth/customers/register')
        .send({
          email: 'awa.client@test.sn',
          password: PASSWORD,
          firstName: 'A',
          lastName: 'B',
          acceptTerms: true,
        })
        .expect(409);
      await api()
        .post('/api/v1/auth/customers/register')
        .send({
          email: 'x@test.sn',
          password: PASSWORD,
          firstName: 'A',
          lastName: 'B',
        })
        .expect(400);
    });

    it('rattache la commande au compte, et reste anonyme sans jeton ou avec un jeton invalide', async () => {
      const linked = await order([line(thieb)], {}, awa).expect(201);
      const anonymous = await order([line(thieb)]).expect(201);
      const badToken = await order(
        [line(thieb)],
        {},
        { accessToken: 'invalide' },
      ).expect(201);
      const rows = await prisma.order.findMany({
        where: {
          id: {
            in: [
              linked.body.order.id,
              anonymous.body.order.id,
              badToken.body.order.id,
            ],
          },
        },
        select: { id: true, customerId: true },
      });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.customerId]));
      expect(byId[linked.body.order.id]).not.toBeNull();
      expect(byId[anonymous.body.order.id]).toBeNull();
      expect(byId[badToken.body.order.id]).toBeNull();
    });
  });

  describe('codes promo (CMD-13)', () => {
    it('réserve la gestion aux rôles autorisés et refuse les doublons', async () => {
      await send(
        'post',
        '/promotions',
        { code: 'X10', name: 'X', type: 'PERCENT', value: 1000 },
        staff,
      ).expect(403);
      await send('post', '/promotions', {
        code: 'bienvenue10',
        name: 'Bienvenue -10 %',
        type: 'PERCENT',
        value: 1000,
        minSubtotal: 3000,
        perCustomerLimit: 1,
      }).expect(201);
      const dup = await send('post', '/promotions', {
        code: 'BIENVENUE10',
        name: 'Doublon',
        type: 'AMOUNT',
        value: 100,
      }).expect(409);
      expect(dup.body.code).toBe('PROMO_CODE_TAKEN');
      await send('post', '/promotions', {
        code: 'BISSAP3',
        name: '2 bissaps achetés = 1 offert',
        type: 'BUY_X_GET_Y',
        buyQuantity: 2,
        freeQuantity: 1,
        menuItemId: bissap,
      }).expect(201);
      const list = await api()
        .get(`${base()}/promotions`)
        .set(bearer(owner))
        .expect(200);
      expect(list.body).toHaveLength(2);
    });

    it('calcule un devis sans créer de commande', async () => {
      const before = await prisma.order.count();
      const res = await quote([line(thieb)], {
        promoCode: 'bienvenue10',
        customerPhone: '+221770000010',
      }).expect(200);
      expect(res.body).toMatchObject({
        promoCode: 'BIENVENUE10',
        subtotal: 3500,
        discountTotal: 350,
        total: 3150,
      });
      expect(await prisma.order.count()).toBe(before);
    });

    it('applique les conditions : minimum, identification, une fois par client', async () => {
      const min = await quote([line(bissap)], {
        promoCode: 'BIENVENUE10',
        customerPhone: '+221770000010',
      }).expect(400);
      expect(min.body).toMatchObject({
        code: 'PROMO_MIN_SUBTOTAL',
        details: { minSubtotal: 3000 },
      });
      const anon = await quote([line(thieb)], {
        promoCode: 'BIENVENUE10',
      }).expect(400);
      expect(anon.body.code).toBe('PROMO_REQUIRES_IDENTIFICATION');

      const first = await order(
        [line(thieb)],
        { promoCode: 'BIENVENUE10' },
        awa,
      ).expect(201);
      expect(first.body.order).toMatchObject({
        discountTotal: 350,
        total: 3150,
        promoCode: 'BIENVENUE10',
      });
      const again = await order(
        [line(thieb)],
        { promoCode: 'BIENVENUE10' },
        awa,
      ).expect(400);
      expect(again.body.code).toBe('PROMO_LIMIT_REACHED');

      // Commande annulée : le code redevient utilisable.
      await api()
        .post(`/api/v1/public/orders/${first.body.order.id}/cancel`)
        .set('X-Order-Token', first.body.trackingToken)
        .send({})
        .expect(200);
      await quote([line(thieb)], { promoCode: 'BIENVENUE10' }, awa).expect(200);
    });

    it('offre un article pour X achetés', async () => {
      const res = await quote([line(bissap, 3)], {
        promoCode: 'BISSAP3',
      }).expect(200);
      expect(res.body).toMatchObject({
        subtotal: 1500,
        discountTotal: 500,
        total: 1000,
      });
      const no = await quote([line(bissap, 2)], {
        promoCode: 'BISSAP3',
      }).expect(400);
      expect(no.body.code).toBe('PROMO_NOT_APPLICABLE');
    });

    it('respecte les dates et la limite globale d’utilisation', async () => {
      await send('post', '/promotions', {
        code: 'BIENTOT',
        name: 'Pas encore',
        type: 'AMOUNT',
        value: 200,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).expect(201);
      expect(
        (await quote([line(jus)], { promoCode: 'BIENTOT' }).expect(400)).body
          .code,
      ).toBe('PROMO_INVALID');

      await send('post', '/promotions', {
        code: 'UNIQUE',
        name: 'Une fois',
        type: 'AMOUNT',
        value: 200,
        usageLimit: 1,
      }).expect(201);
      await order([line(jus)], { promoCode: 'UNIQUE' }).expect(201);
      expect(
        (await order([line(jus)], { promoCode: 'UNIQUE' }).expect(400)).body
          .code,
      ).toBe('PROMO_EXHAUSTED');
      expect(
        (await quote([line(jus)], { promoCode: 'INCONNU' }).expect(400)).body
          .code,
      ).toBe('PROMO_INVALID');
    });
  });

  describe('fidélité (CLI-02)', () => {
    let rewardId: string;
    let voucher: string;
    let paidOrder: string;

    it('configure le programme et ses récompenses', async () => {
      await send('put', '/loyalty', {
        isActive: true,
        pointsPerUnit: 1,
        unitAmount: 100,
        expiryDays: 30,
      }).expect(200);
      rewardId = (
        await send('post', '/loyalty/rewards', {
          name: 'Bissap offert',
          pointsCost: 30,
          type: 'FREE_ITEM',
          menuItemId: bissap,
        }).expect(201)
      ).body.id;
      const program = await api()
        .get(`/api/v1/public/restaurants/${owner.slug}/loyalty`)
        .expect(200);
      expect(program.body).toMatchObject({
        active: true,
        unitAmount: 100,
        rewards: [{ name: 'Bissap offert', pointsCost: 30 }],
      });
    });

    it('crédite les points au règlement complet, uniquement pour les clients avec compte', async () => {
      const mine = await order([line(thieb)], {}, awa).expect(201);
      paidOrder = mine.body.order.id;
      await cash(paidOrder);
      await cash((await order([line(thieb)]).expect(201)).body.order.id); // anonyme

      const loyalty = await api()
        .get('/api/v1/me/loyalty')
        .set(bearer(awa))
        .expect(200);
      expect(loyalty.body).toHaveLength(1);
      expect(loyalty.body[0]).toMatchObject({
        restaurant: { slug: owner.slug },
        points: 35,
        rewards: [{ name: 'Bissap offert', affordable: true }],
      });
      expect(await prisma.loyaltyAccount.count()).toBe(1);
    });

    it('échange des points contre un bon nominatif à usage unique', async () => {
      const redeem = (who: Token) =>
        api()
          .post(
            `/api/v1/me/loyalty/${owner.restaurantId}/rewards/${rewardId}/redeem`,
          )
          .set(bearer(who))
          .send();
      const res = await redeem(awa).expect(201);
      expect(res.body).toMatchObject({
        reward: 'Bissap offert',
        remainingPoints: 5,
      });
      voucher = res.body.code;
      expect(voucher).toMatch(/^FID-[0-9A-F]{8}$/);
      expect((await redeem(awa).expect(409)).body.code).toBe(
        'INSUFFICIENT_POINTS',
      );

      // Bon nominatif : inutilisable par un autre client.
      expect(
        (
          await quote(
            [line(bissap), line(jus)],
            { promoCode: voucher },
            moussa,
          ).expect(400)
        ).body.code,
      ).toBe('PROMO_INVALID');
      const used = await order(
        [line(bissap), line(jus)],
        { promoCode: voucher },
        awa,
      ).expect(201);
      expect(used.body.order).toMatchObject({
        discountTotal: 500,
        total: 1000,
      });
      expect(
        (await order([line(bissap)], { promoCode: voucher }, awa).expect(400))
          .body.code,
      ).toBe('PROMO_EXHAUSTED');
    });

    it('considère payée une commande entièrement couverte par une remise', async () => {
      await send('post', '/promotions', {
        code: 'OFFERT',
        name: 'Offert',
        type: 'AMOUNT',
        value: 100000,
      }).expect(201);
      const res = await order([line(jus)], { promoCode: 'OFFERT' }).expect(201);
      expect(res.body.order).toMatchObject({ total: 0, paymentStatus: 'PAID' });
    });

    it('reprend les points en cas de remboursement total', async () => {
      const payment = await prisma.payment.findFirstOrThrow({
        where: { orderId: paidOrder },
      });
      await api()
        .post(`${base()}/payments/${payment.id}/refunds`)
        .set(bearer(owner))
        .send({ reason: 'Erreur de commande' })
        .expect(201);
      const account = await prisma.loyaltyAccount.findFirstOrThrow({
        include: { transactions: { orderBy: { createdAt: 'asc' } } },
      });
      expect(account.points).toBe(0);
      expect(account.transactions.map((t) => [t.type, t.points])).toEqual([
        ['EARN', 35],
        ['REDEEM', -30],
        ['REVERSAL', -5],
      ]);
    });

    it('permet un ajustement manuel journalisé', async () => {
      const awaUser = await prisma.user.findUniqueOrThrow({
        where: { email: 'awa.client@test.sn' },
      });
      const res = await send('post', '/loyalty/adjustments', {
        userId: awaUser.id,
        points: 20,
        note: 'Geste commercial',
      }).expect(201);
      expect(res.body.points).toBe(20);
      await send('post', '/loyalty/adjustments', {
        userId: awaUser.id,
        points: -50,
        note: 'Trop',
      }).expect(400);
      expect(
        await prisma.auditLog.count({ where: { action: 'loyalty.adjust' } }),
      ).toBe(1);
    });
  });

  describe('avis (CLI-03)', () => {
    let reviewed: { id: string; token: string };

    it('n’accepte un avis qu’une fois la commande servie, une seule fois', async () => {
      const res = await order([line(thieb)], {}, awa).expect(201);
      reviewed = { id: res.body.order.id, token: res.body.trackingToken };
      const review = (body: object, token = reviewed.token) =>
        api()
          .post(`/api/v1/public/orders/${reviewed.id}/review`)
          .set('X-Order-Token', token)
          .send(body);

      expect((await review({ rating: 5 }).expect(409)).body.code).toBe(
        'ORDER_NOT_REVIEWABLE',
      );
      for (const s of ['ACCEPTED', 'READY', 'SERVED'])
        await setStatus(reviewed.id, s);
      await review({ rating: 6 }).expect(400);
      await review({ rating: 5 }, 'faux').expect(404);
      const created = await review({
        rating: 5,
        comment: 'Excellent thiéboudienne',
      }).expect(201);
      expect(created.body).toMatchObject({ rating: 5, authorName: 'Awa' });
      expect((await review({ rating: 1 }).expect(409)).body.code).toBe(
        'ALREADY_REVIEWED',
      );
    });

    it('publie la note moyenne, la réponse du restaurant, et permet la modération', async () => {
      const other = await order([line(jus)]).expect(201);
      for (const s of ['ACCEPTED', 'READY', 'SERVED'])
        await setStatus(other.body.order.id, s);
      await api()
        .post(`/api/v1/public/orders/${other.body.order.id}/review`)
        .set('X-Order-Token', other.body.trackingToken)
        .send({ rating: 2, comment: 'Trop sucré' })
        .expect(201);

      const pub = () =>
        api()
          .get(`/api/v1/public/restaurants/${owner.slug}/reviews`)
          .expect(200);
      expect((await pub()).body).toMatchObject({
        averageRating: 3.5,
        distribution: { 5: 1, 2: 1 },
        meta: { total: 2 },
      });

      const all = await api()
        .get(`${base()}/reviews`)
        .set(bearer(owner))
        .expect(200);
      const bad = all.body.data.find((r: { rating: number }) => r.rating === 2);
      const good = all.body.data.find(
        (r: { rating: number }) => r.rating === 5,
      );
      await api().get(`${base()}/reviews`).set(bearer(staff)).expect(403);

      await api()
        .post(`${base()}/reviews/${good.id}/reply`)
        .set(bearer(owner))
        .send({ reply: 'Merci Awa, à bientôt !' })
        .expect(201);
      await api()
        .patch(`${base()}/reviews/${bad.id}/status`)
        .set(bearer(owner))
        .send({ status: 'HIDDEN' })
        .expect(400);
      await api()
        .patch(`${base()}/reviews/${bad.id}/status`)
        .set(bearer(owner))
        .send({ status: 'HIDDEN', reason: 'Avis injurieux' })
        .expect(200);

      const after = (await pub()).body;
      expect(after).toMatchObject({ averageRating: 5, meta: { total: 1 } });
      expect(after.data[0]).toMatchObject({ reply: 'Merci Awa, à bientôt !' });
    });
  });

  describe('historique et re-commande (CLI-05)', () => {
    it('liste les commandes du client avec leur établissement', async () => {
      const res = await api()
        .get('/api/v1/me/orders')
        .set(bearer(awa))
        .expect(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(5);
      expect(res.body.data[0]).toMatchObject({
        restaurant: { slug: owner.slug, name: 'Le Baobab' },
        trackingToken: expect.any(String),
      });
      expect(res.body.data.some((o: { reviewed: boolean }) => o.reviewed)).toBe(
        true,
      );
      const moussaOrders = await api()
        .get('/api/v1/me/orders')
        .set(bearer(moussa))
        .expect(200);
      expect(moussaOrders.body.meta.total).toBe(0);
    });

    it('reconstruit le panier en signalant les articles devenus indisponibles', async () => {
      const res = await order([line(thieb, 2), line(jus)], {}, awa).expect(201);
      await send('patch', `/menu/items/${jus}/availability`, {
        isAvailable: false,
      }).expect(200);

      const reorder = await api()
        .post(`/api/v1/me/orders/${res.body.order.id}/reorder`)
        .set(bearer(awa))
        .expect(201);
      expect(reorder.body).toMatchObject({
        restaurant: { slug: owner.slug },
        items: [{ menuItemId: thieb, quantity: 2 }],
        unavailable: [{ name: 'Jus de bouye', reason: 'ITEM_UNAVAILABLE' }],
      });
      // Le panier reconstruit est directement commandable.
      await order(reorder.body.items, {}, awa).expect(201);

      const forbidden = await api()
        .post(`/api/v1/me/orders/${res.body.order.id}/reorder`)
        .set(bearer(moussa))
        .expect(403);
      expect(forbidden.body.code).toBe('NOT_YOUR_ORDER');
    });
  });

  it('réserve promotions et fidélité aux forfaits qui les incluent', async () => {
    await api()
      .post('/api/v1/billing/subscription/change')
      .set(bearer(owner))
      .send({ planCode: 'STARTER' })
      .expect(200);
    const res = await api()
      .get(`${base()}/promotions`)
      .set(bearer(owner))
      .expect(403);
    expect(res.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(
      (await quote([line(bissap, 3)], { promoCode: 'BISSAP3' }).expect(400))
        .body.code,
    ).toBe('PROMO_INVALID');
    const program = await api()
      .get(`/api/v1/public/restaurants/${owner.slug}/loyalty`)
      .expect(200);
    expect(program.body).toEqual({ active: false });
  });
});
