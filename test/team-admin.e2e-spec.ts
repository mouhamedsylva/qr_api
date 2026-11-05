import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createSuperAdmin,
  createTestApp,
  FakeSender,
  PASSWORD,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

describe('Équipe, administration, abonnements et conformité (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sender = new FakeSender();
  let owner: Session;
  let other: Session;
  let admin: { accessToken: string; userId: string };
  let ownerUserId: string;

  const api = () => request(app.getHttpServer());
  const base = () => `/api/v1/restaurants/${owner.restaurantId}`;
  const tokenFrom = (url: string) => url.split('/invitation/')[1];

  const invite = (body: object, who: { accessToken: string } = owner) =>
    api().post(`${base()}/team/invitations`).set(bearer(who)).send(body);

  const registerViaInvite = (token: string, body: object = {}) =>
    api()
      .post(`/api/v1/invitations/${token}/register`)
      .send({
        firstName: 'Mariama',
        lastName: 'Ba',
        password: PASSWORD,
        acceptTerms: true,
        ...body,
      });

  const login = (email: string, password = PASSWORD) =>
    api().post('/api/v1/auth/login').send({ email, password });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp(sender));
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'team.owner@test.sn', 'Teranga Grill');
    other = await registerOwner(app, 'team.other@test.sn', 'Voisin');
    admin = await createSuperAdmin(app, prisma, 'admin@qr-order.test');
    ownerUserId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'team.owner@test.sn' },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('équipe (module 7)', () => {
    let staffSession: { accessToken: string; refreshToken: string };
    let staffMembershipId: string;
    let manager: { accessToken: string };

    it('invite par email avec un lien expirant et crée le compte à l’acceptation', async () => {
      const res = await invite({
        email: 'Mariama@Test.sn',
        role: 'STAFF',
        staffProfile: 'SALLE',
      }).expect(201);
      expect(res.body).toMatchObject({
        email: 'mariama@test.sn',
        role: 'STAFF',
      });
      expect(res.body).not.toHaveProperty('tokenHash');
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 6 * 86_400_000,
      );
      const token = tokenFrom(res.body.inviteUrl);
      expect(sender.messages.at(-1)?.body).toContain(res.body.inviteUrl);

      const preview = await api()
        .get(`/api/v1/invitations/${token}`)
        .expect(200);
      expect(preview.body).toMatchObject({
        restaurant: { name: 'Teranga Grill' },
        role: 'STAFF',
        accountExists: false,
      });

      const accepted = await registerViaInvite(token).expect(201);
      expect(accepted.body.restaurantId).toBe(owner.restaurantId);
      staffSession = accepted.body.tokens;

      // Lien à usage unique.
      const reuse = await registerViaInvite(token, {
        email: 'x@test.sn',
      }).expect(404);
      expect(reuse.body.code).toBe('INVITATION_INVALID');

      const me = await api()
        .get('/api/v1/auth/me')
        .set(bearer(staffSession))
        .expect(200);
      expect(me.body).toMatchObject({ emailVerified: true });
      expect(me.body.restaurants[0]).toMatchObject({
        role: 'STAFF',
        staffProfile: 'SALLE',
      });

      const members = await api()
        .get(`${base()}/team/members`)
        .set(bearer(owner))
        .expect(200);
      staffMembershipId = members.body.find(
        (m: { user: { email: string } }) => m.user.email === 'mariama@test.sn',
      ).id;
    });

    it('applique la hiérarchie propriétaire > manager > staff', async () => {
      // Invitation par SMS : l'email est demandé à la création du compte.
      const res = await invite({
        phone: '+221770000001',
        role: 'MANAGER',
      }).expect(201);
      const token = tokenFrom(res.body.inviteUrl);
      expect((await registerViaInvite(token).expect(400)).body.code).toBe(
        'EMAIL_REQUIRED',
      );
      manager = (
        await registerViaInvite(token, { email: 'manager@test.sn' }).expect(201)
      ).body.tokens;

      expect(
        (
          await invite(
            { email: 'm2@test.sn', role: 'MANAGER' },
            manager,
          ).expect(403)
        ).body.code,
      ).toBe('ROLE_HIERARCHY');
      await invite({ email: 'staff2@test.sn', role: 'STAFF' }, manager).expect(
        201,
      );

      // Le manager donne au staff le droit de modifier le menu (AUT-03).
      const updated = await api()
        .patch(`${base()}/team/members/${staffMembershipId}`)
        .set(bearer(manager))
        .send({ permissions: { grant: ['menu.manage'] } })
        .expect(200);
      expect(updated.body.permissions).toContain('menu.manage');

      // Mais ne peut ni promouvoir, ni toucher au propriétaire.
      await api()
        .patch(`${base()}/team/members/${staffMembershipId}`)
        .set(bearer(manager))
        .send({ role: 'MANAGER' })
        .expect(403);
      const ownerMembership = await prisma.membership.findFirstOrThrow({
        where: { restaurantId: owner.restaurantId, role: 'OWNER' },
      });
      await api()
        .delete(`${base()}/team/members/${ownerMembership.id}`)
        .set(bearer(manager))
        .expect(403);
      // Le staff n'a pas accès à la gestion d'équipe.
      await api()
        .get(`${base()}/team/members`)
        .set(bearer(staffSession))
        .expect(403);
    });

    it('rattache un compte existant et vérifie le destinataire', async () => {
      const res = await invite({
        email: 'team.other@test.sn',
        role: 'STAFF',
      }).expect(201);
      const token = tokenFrom(res.body.inviteUrl);
      expect((await registerViaInvite(token).expect(409)).body.code).toBe(
        'ACCOUNT_EXISTS',
      );
      expect(
        (
          await api()
            .post(`/api/v1/invitations/${token}/accept`)
            .set(bearer(manager))
            .expect(403)
        ).body.code,
      ).toBe('INVITATION_EMAIL_MISMATCH');
      await api()
        .post(`/api/v1/invitations/${token}/accept`)
        .set(bearer(other))
        .expect(200);

      const me = await api()
        .get('/api/v1/auth/me')
        .set(bearer(other))
        .expect(200);
      expect(me.body.restaurants).toHaveLength(2);
    });

    it('révoque un accès instantanément et ferme les sessions (EQP-03)', async () => {
      await api().get(base()).set(bearer(staffSession)).expect(200);
      await api()
        .delete(`${base()}/team/members/${staffMembershipId}`)
        .set(bearer(owner))
        .expect(204);
      await api().get(base()).set(bearer(staffSession)).expect(404);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: staffSession.refreshToken })
        .expect(401);
    });

    it('révoque une invitation en attente', async () => {
      const res = await invite({
        email: 'oubli@test.sn',
        role: 'STAFF',
      }).expect(201);
      await api()
        .delete(`${base()}/team/invitations/${res.body.id}`)
        .set(bearer(owner))
        .expect(204);
      await api()
        .get(`/api/v1/invitations/${tokenFrom(res.body.inviteUrl)}`)
        .expect(404);
    });
  });

  describe('forfaits et abonnements (PAY-03)', () => {
    it('expose la grille tarifaire et l’essai gratuit du propriétaire', async () => {
      const plans = await api().get('/api/v1/billing/plans').expect(200);
      expect(plans.body.map((p: { code: string }) => p.code)).toEqual([
        'STARTER',
        'PRO',
        'PREMIUM',
      ]);
      const sub = await api()
        .get('/api/v1/billing/subscription')
        .set(bearer(owner))
        .expect(200);
      expect(sub.body).toMatchObject({
        subscription: { status: 'TRIALING', plan: { code: 'PRO' } },
        effectivePlan: { code: 'PRO' },
        isFallback: false,
        usage: { restaurants: 1 },
      });
    });

    it('applique les quotas de membres et de tables', async () => {
      // Pendant l'essai, le propriétaire peut choisir Starter (3 membres, 10 tables).
      await api()
        .post('/api/v1/billing/subscription/change')
        .set(bearer(owner))
        .send({ planCode: 'STARTER' })
        .expect(200);
      // Équipe : manager + staff2 (en attente) + other = 3 → limite atteinte.
      const members = await invite({
        email: 'quota@test.sn',
        role: 'STAFF',
      }).expect(403);
      expect(members.body).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        details: { resource: 'members', limit: 3 },
      });
      const tables = await api()
        .post(`${base()}/tables/bulk`)
        .set(bearer(owner))
        .send({ prefix: 'T', from: 1, to: 11 })
        .expect(403);
      expect(tables.body.details).toMatchObject({
        resource: 'tables',
        limit: 10,
      });
      await api()
        .post(`${base()}/tables/bulk`)
        .set(bearer(owner))
        .send({ prefix: 'T', from: 1, to: 10 })
        .expect(201);
    });

    it('bascule sur le forfait de repli à la fin de l’essai', async () => {
      await api()
        .post('/api/v1/billing/subscription/change')
        .set(bearer(owner))
        .send({ planCode: 'PRO' })
        .expect(200);
      await prisma.subscription.update({
        where: { userId: ownerUserId },
        data: { trialEndsAt: new Date(Date.now() - 1000) },
      });
      const sub = await api()
        .get('/api/v1/billing/subscription')
        .set(bearer(owner))
        .expect(200);
      expect(sub.body).toMatchObject({
        isFallback: true,
        effectivePlan: { code: 'STARTER' },
      });

      const change = await api()
        .post('/api/v1/billing/subscription/change')
        .set(bearer(owner))
        .send({ planCode: 'PREMIUM' })
        .expect(409);
      expect(change.body.code).toBe('PLAN_CHANGE_REQUIRES_BILLING');
    });
  });

  describe('administration plateforme (module 9)', () => {
    const adminApi = (method: 'get' | 'patch' | 'post', path: string) =>
      api()[method](`/api/v1/admin${path}`).set(bearer(admin));

    it('est réservée aux super-admins', async () => {
      const res = await api()
        .get('/api/v1/admin/restaurants')
        .set(bearer(owner))
        .expect(403);
      expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
    });

    it('liste et recherche les établissements (ADM-01)', async () => {
      const res = await adminApi('get', '/restaurants')
        .query({ search: 'teranga' })
        .expect(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        name: 'Teranga Grill',
        owner: { email: 'team.owner@test.sn' },
        _count: { tables: 10 },
      });
    });

    it('active un abonnement et refuse un forfait trop petit sans forçage', async () => {
      // Starter accepte 10 tables et 3 membres : l'usage actuel tient tout juste.
      await adminApi('patch', `/subscriptions/${ownerUserId}`)
        .send({ planCode: 'STARTER', status: 'ACTIVE' })
        .expect(200);

      await api()
        .post(`${base()}/tables`)
        .set(bearer(owner))
        .send({ label: 'Terrasse 1' })
        .expect(403);

      const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const res = await adminApi('patch', `/subscriptions/${ownerUserId}`)
        .send({ planCode: 'PRO', status: 'ACTIVE', currentPeriodEnd: end })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        plan: { code: 'PRO' },
      });
      await api()
        .post(`${base()}/tables`)
        .set(bearer(owner))
        .send({ label: 'Terrasse 1' })
        .expect(201);

      const downgrade = await adminApi('patch', `/subscriptions/${ownerUserId}`)
        .send({ planCode: 'STARTER' })
        .expect(409);
      expect(downgrade.body).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { exceeded: ['tables'] },
      });
    });

    it('gère les forfaits et leurs feature flags (ADM-04)', async () => {
      const created = await adminApi('post', '/plans')
        .send({
          code: 'PRO_PLUS',
          name: 'Pro+',
          priceMonthly: 50000,
          priceYearly: 500000,
          maxRestaurants: 3,
          maxTables: 100,
          maxMembers: 30,
          features: ['online_payments', 'analytics', 'kds'],
        })
        .expect(201);
      expect(created.body.position).toBe(3);
      await adminApi('post', '/plans')
        .send({
          code: 'X',
          name: 'X',
          priceMonthly: 0,
          priceYearly: 0,
          features: ['teleportation'],
        })
        .expect(400);
      await adminApi('patch', '/plans/PRO_PLUS')
        .send({ code: 'AUTRE' })
        .expect(400);
      const updated = await adminApi('patch', '/plans/PRO_PLUS')
        .send({ priceMonthly: 45000, isActive: false })
        .expect(200);
      expect(updated.body).toMatchObject({
        code: 'PRO_PLUS',
        priceMonthly: 45000,
      });
      const publicPlans = await api().get('/api/v1/billing/plans').expect(200);
      expect(publicPlans.body).toHaveLength(3); // forfait inactif masqué
    });

    it('modère un établissement avec motif (ADM-02)', async () => {
      await adminApi('patch', `/restaurants/${owner.restaurantId}/status`)
        .send({ status: 'SUSPENDED' })
        .expect(400);
      await adminApi('patch', `/restaurants/${owner.restaurantId}/status`)
        .send({ status: 'SUSPENDED', reason: 'Impayés' })
        .expect(200);
      await api().get(`/api/v1/public/restaurants/${owner.slug}`).expect(404);
      await adminApi('patch', `/restaurants/${owner.restaurantId}/status`)
        .send({ status: 'ACTIVE', reason: 'Régularisé' })
        .expect(200);
      await api().get(`/api/v1/public/restaurants/${owner.slug}`).expect(200);
    });

    it('suspend un compte et coupe ses sessions', async () => {
      const session = (await login('team.other@test.sn').expect(200)).body
        .tokens;
      const otherUser = await prisma.user.findUniqueOrThrow({
        where: { email: 'team.other@test.sn' },
      });
      await adminApi('patch', `/users/${otherUser.id}/status`)
        .send({ status: 'SUSPENDED', reason: 'Fraude' })
        .expect(200);
      await api().get('/api/v1/auth/me').set(bearer(session)).expect(401);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      await adminApi('patch', `/users/${admin.userId}/status`)
        .send({ status: 'SUSPENDED', reason: 'Test' })
        .expect(409);
      await adminApi('patch', `/users/${otherUser.id}/status`)
        .send({ status: 'ACTIVE', reason: 'Levée' })
        .expect(200);
    });

    it('fournit les indicateurs plateforme (ADM-03)', async () => {
      const res = await adminApi('get', '/analytics').expect(200);
      expect(res.body).toMatchObject({
        restaurants: { byStatus: { ACTIVE: 2 } },
        subscriptions: { ACTIVE: 1, TRIALING: 1 },
        mrr: { XOF: 35000 },
        churnRate: 0,
      });
    });

    it('consulte le journal d’audit global (ADM-08)', async () => {
      const res = await adminApi('get', '/audit-logs')
        .query({ action: 'admin.' })
        .expect(200);
      const actions = res.body.data.map((l: { action: string }) => l.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'admin.restaurant_status',
          'admin.user_status',
          'admin.subscription_update',
          'admin.plan_create',
        ]),
      );
      expect(res.body.data[0].actor.email).toBe('admin@qr-order.test');
    });
  });

  describe('conformité (module 14)', () => {
    it('exige l’acceptation des CGU et la conserve', async () => {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({
          email: 'sans-cgu@test.sn',
          password: PASSWORD,
          firstName: 'A',
          lastName: 'B',
          restaurantName: 'Sans CGU',
        })
        .expect(400);
      expect(JSON.stringify(res.body.details)).toContain(
        'conditions générales',
      );
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: 'team.owner@test.sn' },
      });
      expect(user).toMatchObject({ termsVersion: '2026-10' });
      expect(user.termsAcceptedAt).not.toBeNull();
    });

    it('limite le journal d’activité au restaurant et à la permission audit.view', async () => {
      const res = await api()
        .get(`${base()}/audit-logs`)
        .set(bearer(owner))
        .expect(200);
      expect(
        res.body.data.every(
          (l: { restaurantId: string }) =>
            l.restaurantId === owner.restaurantId,
        ),
      ).toBe(true);
      expect(res.body.data.map((l: { action: string }) => l.action)).toContain(
        'team.invite',
      );
    });

    it('le journal d’audit est inaltérable en base', async () => {
      const log = await prisma.auditLog.findFirstOrThrow();
      await expect(
        prisma.auditLog.update({
          where: { id: log.id },
          data: { action: 'falsifié' },
        }),
      ).rejects.toThrow(/ajout seul/);
      await expect(
        prisma.auditLog.delete({ where: { id: log.id } }),
      ).rejects.toThrow(/ajout seul/);
    });

    it('exporte les données personnelles (CON-03)', async () => {
      const res = await api()
        .get('/api/v1/auth/me/export')
        .set(bearer(owner))
        .expect(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.body.profile).toMatchObject({ email: 'team.owner@test.sn' });
      expect(res.body.profile).not.toHaveProperty('passwordHash');
      expect(res.body.sessions.length).toBeGreaterThan(0);
      expect(res.body.activity.length).toBeGreaterThan(0);
    });

    it('anonymise les données d’un client à sa demande', async () => {
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
        .send({ name: 'Boissons' });
      const item = await api()
        .post(`${base()}/menu/items`)
        .set(bearer(owner))
        .send({
          categoryId: category.body.id,
          name: 'Café Touba',
          priceAmount: 300,
        });
      const order = await api()
        .post('/api/v1/public/orders')
        .set('Idempotency-Key', `rgpd-${randomUUID()}`)
        .send({
          mode: 'TAKEAWAY',
          restaurantSlug: owner.slug,
          customerName: 'Awa Ndiaye',
          customerPhone: '+221771112233',
          items: [{ menuItemId: item.body.id, quantity: 1 }],
        })
        .expect(201);

      const res = await api()
        .post(`${base()}/privacy/anonymize-customer`)
        .set(bearer(owner))
        .send({ phone: '+221771112233' })
        .expect(200);
      expect(res.body.orders).toBe(1);
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.body.order.id },
      });
      expect(row).toMatchObject({
        customerName: null,
        customerPhone: null,
        total: 300,
      });
    });

    it('supprime un compte par anonymisation (droit à l’effacement)', async () => {
      const owned = await api()
        .delete('/api/v1/auth/me')
        .set(bearer(owner))
        .send({ password: PASSWORD })
        .expect(409);
      expect(owned.body.code).toBe('OWNER_HAS_RESTAURANTS');

      const managerLogin = (await login('manager@test.sn').expect(200)).body
        .tokens;
      await api()
        .delete('/api/v1/auth/me')
        .set(bearer(managerLogin))
        .send({ password: 'Mauvais123' })
        .expect(401);
      await api()
        .delete('/api/v1/auth/me')
        .set(bearer(managerLogin))
        .send({ password: PASSWORD })
        .expect(204);

      await login('manager@test.sn').expect(401);
      await api().get('/api/v1/auth/me').set(bearer(managerLogin)).expect(401);
      const anonymized = await prisma.user.findFirstOrThrow({
        where: { email: { startsWith: 'supprime+' } },
      });
      expect(anonymized).toMatchObject({
        firstName: 'Utilisateur',
        phone: null,
      });
    });
  });
});
