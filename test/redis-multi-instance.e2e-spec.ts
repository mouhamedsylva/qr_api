import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import { API_RATE_LIMIT } from '../src/integrations/api-key.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  createMember,
  createTestApp,
  registerOwner,
  resetDatabase,
  Session,
} from './helpers';

const REDIS_URL = 'redis://127.0.0.1:6379';

/**
 * Déploiement horizontal : deux instances de l'API partagent la base et Redis.
 * Nécessite le Redis de Laragon (port 6379).
 */
describe('Plusieurs instances avec Redis (e2e)', () => {
  let a: INestApplication<App>;
  let b: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Session;
  let staff: { accessToken: string };
  let itemId: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const probe = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    await probe.connect().catch(() => {
      throw new Error('Redis doit tourner (Laragon) sur 127.0.0.1:6379');
    });
    await probe.quit();

    // Lu par ConfigService à la création des applications.
    process.env.REDIS_URL = REDIS_URL;
    ({ app: a, prisma } = await createTestApp());
    ({ app: b } = await createTestApp());
    await a.listen(0);
    await b.listen(0);
    await resetDatabase(prisma);

    owner = await registerOwner(
      a,
      `redis.${Date.now()}@test.sn`,
      'Multi Instances',
    );
    staff = await createMember(
      a,
      prisma,
      `redis.staff.${Date.now()}@test.sn`,
      owner.restaurantId,
    );
    const premium = await prisma.plan.findUniqueOrThrow({
      where: { code: 'PREMIUM' },
    });
    await prisma.subscription.updateMany({ data: { planId: premium.id } });
    const base = `/api/v1/restaurants/${owner.restaurantId}`;
    const category = await request(a.getHttpServer())
      .post(`${base}/menu/categories`)
      .set(bearer(owner))
      .send({ name: 'Carte' });
    itemId = (
      await request(a.getHttpServer())
        .post(`${base}/menu/items`)
        .set(bearer(owner))
        .send({
          categoryId: category.body.id,
          name: 'Domoda',
          priceAmount: 2000,
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    delete process.env.REDIS_URL;
    await a.close();
    await b.close();
  });

  it('relaie le temps réel entre instances', async () => {
    const port = Number(new URL(await a.getUrl()).port);
    const kitchen = io(`http://127.0.0.1:${port}/realtime`, {
      auth: { token: staff.accessToken },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(kitchen);
    await new Promise<void>((resolve, reject) => {
      kitchen.once('connect', () => resolve());
      kitchen.once('connect_error', reject);
    });
    expect(
      await kitchen.emitWithAck('subscribe', {
        restaurantId: owner.restaurantId,
      }),
    ).toMatchObject({ ok: true });

    const received = new Promise<{ payload: { id: string } }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Événement non relayé')),
          5000,
        );
        kitchen.once('order.created', (event: { payload: { id: string } }) => {
          clearTimeout(timer);
          resolve(event);
        });
      },
    );
    // Commande créée sur l'instance B ; la cuisine est connectée à l'instance A.
    const order = await request(b.getHttpServer())
      .post(`/api/v1/restaurants/${owner.restaurantId}/orders`)
      .set(bearer(staff))
      .set('Idempotency-Key', `redis-${randomUUID()}`)
      .send({ mode: 'TAKEAWAY', items: [{ menuItemId: itemId, quantity: 1 }] })
      .expect(201);
    expect((await received).payload.id).toBe(order.body.id);
  });

  it('partage le quota d’une clé d’API entre instances', async () => {
    const key = (
      await request(a.getHttpServer())
        .post(`/api/v1/restaurants/${owner.restaurantId}/integrations/api-keys`)
        .set(bearer(owner))
        .send({ name: 'Partagée', scopes: ['menu:read'] })
        .expect(201)
    ).body.key as string;
    const call = (app: INestApplication<App>) =>
      request(app.getHttpServer())
        .get('/api/v1/integrations/me')
        .set('X-Api-Key', key);

    // Éviter de chevaucher deux fenêtres d'une minute pendant le test.
    const msLeft = 60_000 - (Date.now() % 60_000);
    if (msLeft < 8_000) await new Promise((r) => setTimeout(r, msLeft + 100));

    for (let i = 0; i < API_RATE_LIMIT / 2; i++) {
      await call(a).expect(200);
      await call(b).expect(200);
    }
    // Chaque instance n'a vu que la moitié des requêtes : seul un compteur commun bloque ici.
    const limited = await call(a).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    await call(b).expect(429);
  });
});
