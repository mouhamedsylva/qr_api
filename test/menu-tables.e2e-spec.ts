import { INestApplication } from '@nestjs/common';
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

describe('Menus & Tables (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let other: Session;
  let staff: { accessToken: string };

  const api = () => request(app.getHttpServer());
  const menu = (s: Session = owner) =>
    `/api/v1/restaurants/${s.restaurantId}/menu`;
  const base = (s: Session = owner) => `/api/v1/restaurants/${s.restaurantId}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    owner = await registerOwner(app, 'menu.owner@test.sn', 'Le Thiéboudienne');
    other = await registerOwner(app, 'menu.other@test.sn', 'Concurrent');
    staff = await createMember(
      app,
      prisma,
      'menu.staff@test.sn',
      owner.restaurantId,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  describe('menus', () => {
    let platsId: string;
    let boissonsId: string;
    let itemId: string;

    it('crée des catégories et une sous-catégorie', async () => {
      platsId = (
        await api()
          .post(`${menu()}/categories`)
          .set(bearer(owner))
          .send({ name: 'Plats' })
          .expect(201)
      ).body.id;
      boissonsId = (
        await api()
          .post(`${menu()}/categories`)
          .set(bearer(owner))
          .send({ name: 'Boissons' })
          .expect(201)
      ).body.id;
      const sub = await api()
        .post(`${menu()}/categories`)
        .set(bearer(owner))
        .send({ name: 'Jus locaux', parentId: boissonsId })
        .expect(201);

      // Pas de sous-sous-catégorie.
      const nested = await api()
        .post(`${menu()}/categories`)
        .set(bearer(owner))
        .send({ name: 'Trop profond', parentId: sub.body.id })
        .expect(400);
      expect(nested.body.code).toBe('INVALID_PARENT');

      const tree = await api()
        .get(`${menu()}/categories`)
        .set(bearer(owner))
        .expect(200);
      expect(tree.body.map((c: { name: string }) => c.name)).toEqual([
        'Plats',
        'Boissons',
      ]);
      expect(tree.body[1].children[0].name).toBe('Jus locaux');
    });

    it('crée un article avec options et valide les groupes', async () => {
      const res = await api()
        .post(`${menu()}/items`)
        .set(bearer(owner))
        .send({
          categoryId: platsId,
          name: 'Thiéboudienne',
          priceAmount: 3500,
          prepTimeMinutes: 20,
          dietaryTags: ['HALAL'],
          optionGroups: [
            {
              name: 'Taille',
              isRequired: true,
              options: [
                { name: 'Normale' },
                { name: 'Grande', priceDelta: 1000 },
              ],
            },
            {
              name: 'Suppléments',
              maxSelect: 2,
              options: [
                { name: 'Piment', priceDelta: 0 },
                { name: 'Œuf', priceDelta: 300 },
              ],
            },
          ],
        })
        .expect(201);
      itemId = res.body.id;
      expect(res.body.available).toBe(true);
      expect(res.body.optionGroups[0]).toMatchObject({
        name: 'Taille',
        isRequired: true,
        minSelect: 1,
        maxSelect: 1,
      });
      expect(res.body.optionGroups[1].options).toHaveLength(2);

      const invalid = await api()
        .post(`${menu()}/items`)
        .set(bearer(owner))
        .send({
          categoryId: platsId,
          name: 'Invalide',
          priceAmount: 100,
          optionGroups: [
            { name: 'G', minSelect: 3, maxSelect: 3, options: [{ name: 'A' }] },
          ],
        })
        .expect(400);
      expect(invalid.body.code).toBe('INVALID_OPTION_GROUP');
    });

    it("refuse une catégorie d'un autre restaurant", async () => {
      const foreign = await api()
        .post(`${menu(other)}/categories`)
        .set(bearer(other))
        .send({ name: 'Étrangère' })
        .expect(201);
      const res = await api()
        .post(`${menu()}/items`)
        .set(bearer(owner))
        .send({
          categoryId: foreign.body.id,
          name: 'Intrus',
          priceAmount: 100,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_CATEGORY');

      // Et l'autre restaurant ne peut pas lire nos articles.
      await api()
        .get(`${menu(other)}/items/${itemId}`)
        .set(bearer(other))
        .expect(404);
    });

    it('journalise les changements de prix', async () => {
      await api()
        .patch(`${menu()}/items/${itemId}`)
        .set(bearer(owner))
        .send({ priceAmount: 4000 })
        .expect(200);
      const log = await prisma.auditLog.findFirst({
        where: { action: 'menu.price_change', entityId: itemId },
      });
      expect(log?.before).toEqual({ priceAmount: 3500 });
      expect(log?.after).toEqual({ priceAmount: 4000 });
    });

    it('le staff marque un article épuisé mais ne modifie pas le menu', async () => {
      await api()
        .patch(`${menu()}/items/${itemId}`)
        .set(bearer(staff))
        .send({ priceAmount: 1 })
        .expect(403);

      const soldOut = await api()
        .patch(`${menu()}/items/${itemId}/availability`)
        .set(bearer(staff))
        .send({ isAvailable: false })
        .expect(200);
      expect(soldOut.body.available).toBe(false);

      // Remise automatique à disponible : date passée → de nouveau disponible.
      const back = await api()
        .patch(`${menu()}/items/${itemId}/availability`)
        .set(bearer(staff))
        .send({ availableAgainAt: new Date(Date.now() - 1000).toISOString() })
        .expect(200);
      expect(back.body.available).toBe(true);

      const noStock = await api()
        .patch(`${menu()}/items/${itemId}/availability`)
        .set(bearer(staff))
        .send({ isAvailable: true, stockQuantity: 0 })
        .expect(200);
      expect(noStock.body.available).toBe(false);
      await api()
        .patch(`${menu()}/items/${itemId}/availability`)
        .set(bearer(staff))
        .send({ stockQuantity: null })
        .expect(200);
    });

    it('réordonne les articles et liste avec pagination', async () => {
      const second = await api()
        .post(`${menu()}/items`)
        .set(bearer(owner))
        .send({ categoryId: platsId, name: 'Yassa poulet', priceAmount: 3000 })
        .expect(201);
      await api()
        .put(`${menu()}/items/reorder`)
        .set(bearer(owner))
        .send({ categoryId: platsId, ids: [second.body.id, itemId] })
        .expect(204);

      const list = await api()
        .get(`${menu()}/items`)
        .query({ categoryId: platsId, limit: 1 })
        .set(bearer(owner))
        .expect(200);
      expect(list.body.meta).toMatchObject({ total: 2, totalPages: 2 });
      expect(list.body.data[0].name).toBe('Yassa poulet');

      const search = await api()
        .get(`${menu()}/items`)
        .query({ search: 'Thi' })
        .set(bearer(owner))
        .expect(200);
      expect(search.body.data).toHaveLength(1);
    });

    it('refuse de supprimer une catégorie non vide', async () => {
      const res = await api()
        .delete(`${menu()}/categories/${platsId}`)
        .set(bearer(owner))
        .expect(409);
      expect(res.body.code).toBe('CATEGORY_NOT_EMPTY');
    });

    it('expose le menu public sans les données internes', async () => {
      await api()
        .post(`${menu()}/items`)
        .set(bearer(owner))
        .send({
          categoryId: boissonsId,
          name: 'Brouillon caché',
          priceAmount: 500,
          isActive: false,
        })
        .expect(201);

      const res = await api()
        .get(`/api/v1/public/restaurants/${owner.slug}/menu`)
        .expect(200);
      expect(res.body.currency).toBe('XOF');
      // « Boissons » n'a que des articles inactifs : masquée.
      expect(res.body.categories).toHaveLength(1);
      const [plats] = res.body.categories;
      expect(plats.items.map((i: { name: string }) => i.name)).toEqual([
        'Yassa poulet',
        'Thiéboudienne',
      ]);
      expect(plats.items[1]).not.toHaveProperty('stockQuantity');
      expect(plats.items[1]).toHaveProperty('available', true);
    });
  });

  describe('tables et QR codes', () => {
    let zoneId: string;
    let tableId: string;

    it('crée une zone et des tables par lot', async () => {
      zoneId = (
        await api()
          .post(`${base()}/zones`)
          .set(bearer(owner))
          .send({ name: 'Terrasse' })
          .expect(201)
      ).body.id;

      const res = await api()
        .post(`${base()}/tables/bulk`)
        .set(bearer(owner))
        .send({ prefix: 'T', from: 1, to: 5, zoneId, capacity: 4 })
        .expect(201);
      expect(res.body.map((t: { label: string }) => t.label)).toEqual([
        'T1',
        'T2',
        'T3',
        'T4',
        'T5',
      ]);
      expect(res.body[0].zone.name).toBe('Terrasse');
      tableId = res.body[0].id;

      const dup = await api()
        .post(`${base()}/tables`)
        .set(bearer(owner))
        .send({ label: 'T3' })
        .expect(409);
      expect(dup.body.details.labels).toEqual(['T3']);
    });

    it('refuse une zone appartenant à un autre restaurant', async () => {
      const res = await api()
        .post(`${base(other)}/tables`)
        .set(bearer(other))
        .send({ label: 'X1', zoneId })
        .expect(404);
      expect(res.body.code).toBe('ZONE_NOT_FOUND');
    });

    it('le staff change le statut mais ne crée pas de table', async () => {
      await api()
        .post(`${base()}/tables`)
        .set(bearer(staff))
        .send({ label: 'S1' })
        .expect(403);
      const res = await api()
        .patch(`${base()}/tables/${tableId}/status`)
        .set(bearer(staff))
        .send({ status: 'OCCUPIED' })
        .expect(200);
      expect(res.body.status).toBe('OCCUPIED');

      const occupied = await api()
        .get(`${base()}/tables`)
        .query({ status: 'OCCUPIED' })
        .set(bearer(staff))
        .expect(200);
      expect(occupied.body).toHaveLength(1);
    });

    it('génère un QR signé résolu publiquement avec le menu', async () => {
      const qr = await api()
        .get(`${base()}/tables/${tableId}/qr`)
        .set(bearer(owner))
        .expect(200);
      expect(qr.body.url).toMatch(/^http:\/\/localhost:5173\/t\//);
      const token = (qr.body.url as string).split('/t/')[1];

      const resolved = await api()
        .get(`/api/v1/public/qr/${token}`)
        .expect(200);
      expect(resolved.body.table).toMatchObject({ id: tableId, label: 'T1' });
      expect(resolved.body.restaurant.slug).toBe(owner.slug);
      expect(resolved.body.menu.categories.length).toBeGreaterThan(0);

      // Jeton falsifié : autre table avec la même signature.
      const [, version, sig] = token.split('.');
      const forged = `${tableId.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}.${version}.${sig}`;
      const bad = await api().get(`/api/v1/public/qr/${forged}`).expect(404);
      expect(bad.body.code).toBe('INVALID_QR');
    });

    it("régénère le QR et invalide l'ancien", async () => {
      const before = await api()
        .get(`${base()}/tables/${tableId}/qr`)
        .set(bearer(owner));
      const oldToken = (before.body.url as string).split('/t/')[1];

      const regen = await api()
        .post(`${base()}/tables/${tableId}/qr/regenerate`)
        .set(bearer(owner))
        .expect(200);
      expect(regen.body.version).toBe(before.body.version + 1);
      const newToken = (regen.body.url as string).split('/t/')[1];

      await api().get(`/api/v1/public/qr/${oldToken}`).expect(404);
      await api().get(`/api/v1/public/qr/${newToken}`).expect(200);
    });

    // L'encodage PNG (pngjs, JavaScript pur) est ~100× plus lent dans le bac à
    // sable de Jest (~4 s) qu'en Node (~60 ms en production) : délai allongé.
    it('produit une image PNG et SVG du QR', async () => {
      const png = await api()
        .get(`${base()}/tables/${tableId}/qr/image`)
        .query({ size: 128 })
        .set(bearer(owner))
        .buffer(true)
        .expect(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG');

      const svg = await api()
        .get(`${base()}/tables/${tableId}/qr/image`)
        .query({ format: 'svg', size: 256 })
        .set(bearer(owner))
        .expect(200);
      expect(svg.headers['content-type']).toContain('image/svg+xml');
    }, 20_000);

    it("un QR de table supprimée n'est plus valide", async () => {
      const qr = await api()
        .get(`${base()}/tables/${tableId}/qr`)
        .set(bearer(owner));
      const token = (qr.body.url as string).split('/t/')[1];
      await api()
        .delete(`${base()}/tables/${tableId}`)
        .set(bearer(owner))
        .expect(204);
      await api().get(`/api/v1/public/qr/${token}`).expect(404);
    });
  });
});
