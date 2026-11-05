import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createTestApp,
  FakeSender,
  PASSWORD as password,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

describe('Auth & Restaurants (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sender = new FakeSender();

  let ownerA: Session;
  let ownerB: Session;

  const api = () => request(app.getHttpServer());
  const register = (email: string, restaurantName: string) =>
    registerOwner(app, email, restaurantName);

  function login(email: string, pwd = password) {
    return api().post('/api/v1/auth/login').send({ email, password: pwd });
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp(sender));
    await resetDatabase(prisma);

    ownerA = await register('owner.a@test.sn', 'Chez Awa');
    ownerB = await register('owner.b@test.sn', 'Le Maquis B');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('socle', () => {
    it('GET /health répond ok', async () => {
      const res = await api().get('/api/v1/health').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('refuse une route protégée sans jeton', async () => {
      const res = await api().get('/api/v1/auth/me').expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('renvoie une erreur de validation uniforme', async () => {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({ email: 'pas-un-email', password: 'court' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.body.details)).toBe(true);
    });
  });

  describe('inscription et connexion', () => {
    it("crée l'établissement, la membership OWNER et les horaires", async () => {
      const membership = await prisma.membership.findFirst({
        where: { restaurantId: ownerA.restaurantId },
      });
      expect(membership?.role).toBe('OWNER');
      expect(ownerA.slug).toBe('chez-awa');
      const hours = await prisma.openingHour.count({
        where: { restaurantId: ownerA.restaurantId },
      });
      expect(hours).toBe(7);
      expect(sender.lastCodeFor('owner.a@test.sn')).toMatch(/^\d{6}$/);
    });

    it('refuse un email déjà utilisé', async () => {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({
          email: 'OWNER.A@test.sn',
          password,
          firstName: 'X',
          lastName: 'Y',
          restaurantName: 'Doublon',
          acceptTerms: true,
        })
        .expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it('connecte et renvoie le profil avec les établissements', async () => {
      const res = await login('owner.a@test.sn').expect(200);
      const me = await api()
        .get('/api/v1/auth/me')
        .set(bearer(res.body.tokens))
        .expect(200);
      expect(me.body.restaurants).toHaveLength(1);
      expect(me.body.restaurants[0]).toMatchObject({
        id: ownerA.restaurantId,
        role: 'OWNER',
      });
      expect(me.body).not.toHaveProperty('passwordHash');
    });

    it('vérifie l’email par OTP', async () => {
      const code = sender.lastCodeFor('owner.a@test.sn');
      const res = await api()
        .post('/api/v1/auth/otp/verify')
        .set(bearer(ownerA))
        .send({ channel: 'EMAIL', code })
        .expect(200);
      expect(res.body.emailVerified).toBe(true);
    });

    it('verrouille le compte après 5 échecs', async () => {
      await register('lock@test.sn', 'Lock Resto');
      for (let i = 0; i < 5; i++) {
        await login('lock@test.sn', 'Mauvais123').expect(401);
      }
      const res = await login('lock@test.sn').expect(423);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
    });
  });

  describe('refresh token rotatif', () => {
    it('fait tourner le jeton et détecte la réutilisation', async () => {
      const { body } = await login('owner.b@test.sn').expect(200);
      const first = body.tokens.refreshToken as string;

      const rotated = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first })
        .expect(200);
      const second = rotated.body.refreshToken as string;
      expect(second).not.toBe(first);

      const reuse = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first })
        .expect(401);
      expect(reuse.body.code).toBe('TOKEN_REUSED');

      // Toute la famille est révoquée, y compris le jeton légitime.
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: second })
        .expect(401);
    });

    it('logout révoque le jeton', async () => {
      const { body } = await login('owner.b@test.sn').expect(200);
      await api()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: body.tokens.refreshToken })
        .expect(204);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: body.tokens.refreshToken })
        .expect(401);
    });
  });

  describe('mot de passe oublié', () => {
    it('réinitialise et révoque les sessions', async () => {
      const email = 'reset@test.sn';
      const session = await register(email, 'Reset Resto');
      await api()
        .post('/api/v1/auth/password/forgot')
        .send({ email: 'inconnu@test.sn' })
        .expect(200);

      await prisma.otpCode.deleteMany({ where: { user: { email } } }); // lève le délai entre deux envois
      await api()
        .post('/api/v1/auth/password/forgot')
        .send({ email })
        .expect(200);
      const code = sender.lastCodeFor(email);

      await api()
        .post('/api/v1/auth/password/reset')
        .send({ email, code: '000000', newPassword: 'Nouveau123' })
        .expect(400);
      await api()
        .post('/api/v1/auth/password/reset')
        .send({ email, code, newPassword: 'Nouveau123' })
        .expect(200);

      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      await login(email, 'Nouveau123').expect(200);
    });
  });

  describe('isolation multi-tenant et permissions', () => {
    it("un OWNER ne voit pas l'établissement d'un autre", async () => {
      await api()
        .get(`/api/v1/restaurants/${ownerA.restaurantId}`)
        .set(bearer(ownerB))
        .expect(404);
      await api()
        .patch(`/api/v1/restaurants/${ownerA.restaurantId}`)
        .set(bearer(ownerB))
        .send({ name: 'Piraté' })
        .expect(404);
    });

    it('un STAFF peut lire mais pas modifier', async () => {
      const staff = await prisma.user.create({
        data: {
          email: 'staff@test.sn',
          passwordHash: await hash(password),
          firstName: 'Moussa',
          lastName: 'Fall',
        },
      });
      await prisma.membership.create({
        data: {
          userId: staff.id,
          restaurantId: ownerA.restaurantId,
          role: 'STAFF',
        },
      });
      const { body } = await login('staff@test.sn').expect(200);

      await api()
        .get(`/api/v1/restaurants/${ownerA.restaurantId}`)
        .set(bearer(body.tokens))
        .expect(200);
      const res = await api()
        .patch(`/api/v1/restaurants/${ownerA.restaurantId}`)
        .set(bearer(body.tokens))
        .send({ name: 'Nouveau nom' })
        .expect(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');

      // Permission accordée dynamiquement (AUT-03), effective immédiatement.
      await prisma.membership.update({
        where: {
          userId_restaurantId: {
            userId: staff.id,
            restaurantId: ownerA.restaurantId,
          },
        },
        data: { permissions: { grant: ['restaurant.update'] } },
      });
      await api()
        .patch(`/api/v1/restaurants/${ownerA.restaurantId}`)
        .set(bearer(body.tokens))
        .send({ description: 'Cuisine sénégalaise' })
        .expect(200);
    });

    it('rejette un restaurantId non UUID', async () => {
      await api()
        .get('/api/v1/restaurants/pas-un-uuid')
        .set(bearer(ownerA))
        .expect(404);
    });
  });

  describe('gestion du restaurant', () => {
    const base = () => `/api/v1/restaurants/${ownerA.restaurantId}`;

    it('met à jour les taxes et journalise avant/après', async () => {
      const res = await api()
        .patch(`${base()}/tax`)
        .set(bearer(ownerA))
        .send({ taxEnabled: true, taxRateBp: 1800 })
        .expect(200);
      expect(res.body).toMatchObject({ taxEnabled: true, taxRateBp: 1800 });

      const log = await prisma.auditLog.findFirst({
        where: {
          restaurantId: ownerA.restaurantId,
          action: 'restaurant.update_tax',
        },
      });
      expect(log?.before).toMatchObject({ taxEnabled: false, taxRateBp: 0 });
      expect(log?.after).toMatchObject({ taxEnabled: true, taxRateBp: 1800 });
    });

    it('refuse un fuseau horaire ou une devise invalides', async () => {
      await api()
        .patch(`${base()}/regional`)
        .set(bearer(ownerA))
        .send({ timezone: 'Mars/Olympus', currency: 'ZZZ' })
        .expect(400);
    });

    it('gère horaires, fermetures et statut ouvert/fermé', async () => {
      await api()
        .put(`${base()}/opening-hours`)
        .set(bearer(ownerA))
        .send({
          hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
            dayOfWeek: d,
            opensAt: '00:00',
            closesAt: '00:00',
          })),
        })
        .expect(200);
      let status = await api()
        .get(`${base()}/is-open`)
        .set(bearer(ownerA))
        .expect(200);
      expect(status.body.isOpen).toBe(true);

      const now = Date.now();
      const closure = await api()
        .post(`${base()}/closures`)
        .set(bearer(ownerA))
        .send({
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 3_600_000).toISOString(),
          reason: 'Inventaire',
        })
        .expect(201);
      status = await api().get(`${base()}/is-open`).set(bearer(ownerA));
      expect(status.body).toEqual({ isOpen: false, reason: 'CLOSURE' });

      // Un autre tenant ne peut pas supprimer cette fermeture.
      await api()
        .delete(
          `/api/v1/restaurants/${ownerB.restaurantId}/closures/${closure.body.id}`,
        )
        .set(bearer(ownerB))
        .expect(404);
      await api()
        .delete(`${base()}/closures/${closure.body.id}`)
        .set(bearer(ownerA))
        .expect(204);
      status = await api().get(`${base()}/is-open`).set(bearer(ownerA));
      expect(status.body.isOpen).toBe(true);
    });

    it('expose la page publique par slug sans authentification', async () => {
      const res = await api()
        .get(`/api/v1/public/restaurants/${ownerA.slug}`)
        .expect(200);
      expect(res.body).toMatchObject({ name: 'Chez Awa', currency: 'XOF' });
      expect(res.body).not.toHaveProperty('ownerId');
      expect(res.body).toHaveProperty('isOpen');
    });

    it("limite le nombre d'établissements selon le forfait (RES-07)", async () => {
      // Essai Pro : un seul établissement.
      const limited = await api()
        .post('/api/v1/restaurants')
        .set(bearer(ownerA))
        .send({ name: 'Chez Awa' })
        .expect(403);
      expect(limited.body).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        details: { resource: 'restaurants', limit: 1 },
      });

      // Premium : établissements illimités.
      const premium = await prisma.plan.findUniqueOrThrow({
        where: { code: 'PREMIUM' },
      });
      await prisma.subscription.updateMany({
        where: {
          user: { email: { in: ['owner.a@test.sn', 'owner.b@test.sn'] } },
        },
        data: { planId: premium.id },
      });
      await api()
        .post('/api/v1/restaurants')
        .set(bearer(ownerA))
        .send({ name: 'Chez Awa' })
        .expect(201);
      const list = await api()
        .get('/api/v1/restaurants')
        .set(bearer(ownerA))
        .expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body[1].slug).toMatch(/^chez-awa-[0-9a-f]{6}$/);
    });

    it('supprime logiquement un établissement (OWNER)', async () => {
      const created = await api()
        .post('/api/v1/restaurants')
        .set(bearer(ownerB))
        .send({ name: 'Éphémère' })
        .expect(201);
      await api()
        .delete(`/api/v1/restaurants/${created.body.id}`)
        .set(bearer(ownerB))
        .expect(204);
      await api()
        .get(`/api/v1/restaurants/${created.body.id}`)
        .set(bearer(ownerB))
        .expect(404);
      const row = await prisma.restaurant.findUnique({
        where: { id: created.body.id },
      });
      expect(row?.deletedAt).not.toBeNull();
    });
  });
});
