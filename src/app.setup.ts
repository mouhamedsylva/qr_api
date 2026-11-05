import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { RedisIoAdapter } from './redis/redis-io.adapter';

/** Configuration HTTP partagée entre main.ts et les tests e2e. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(helmet());
  app.enableCors({
    origin: config
      .get<string>('CORS_ORIGINS')
      ?.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  });
  app.enableShutdownHooks();

  // Plusieurs instances : le temps réel transite par Redis.
  const redisUrl = config.get<string>('REDIS_URL');
  if (redisUrl) {
    app.useWebSocketAdapter(new RedisIoAdapter(app, redisUrl));
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('QR-Order API')
      .setDescription('API REST de la plateforme QR-Order')
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document);
}
