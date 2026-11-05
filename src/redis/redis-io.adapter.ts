import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Adaptateur Socket.IO adossé à Redis : un événement émis par une instance
 * atteint les clients connectés à toutes les autres (déploiement horizontal).
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(app: INestApplicationContext, url: string) {
    super(app);
    this.pub = new Redis(url, { maxRetriesPerRequest: 2 });
    this.sub = this.pub.duplicate();
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all([
      this.pub.quit().catch(() => undefined),
      this.sub.quit().catch(() => undefined),
    ]);
  }
}
