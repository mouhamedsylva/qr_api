import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Client Redis partagé, ou null si REDIS_URL n'est pas configuré. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
class RedisShutdown implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}

/**
 * Redis facultatif : sans REDIS_URL, l'API fonctionne sur une instance
 * (quotas en mémoire, temps réel local). Avec Redis, plusieurs instances
 * partagent les quotas et les événements temps réel.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        return url ? new Redis(url, { maxRetriesPerRequest: 2 }) : null;
      },
    },
    RedisShutdown,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
