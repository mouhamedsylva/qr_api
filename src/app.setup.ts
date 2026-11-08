import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'express';
import helmet from 'helmet';
import { StorageService, UPLOADS_ROUTE } from './storage/storage.service';
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

  // Fichiers envoyés (photos des plats) : affichés par le back-office et la PWA,
  // donc autorisés en cross-origin (helmet bloque par défaut), mis en cache longtemps
  // (chaque envoi a un nom unique).
  (app as NestExpressApplication).useStaticAssets(
    app.get(StorageService).root,
    {
      prefix: UPLOADS_ROUTE,
      index: false,
      dotfiles: 'deny',
      maxAge: '365d',
      immutable: true,
      setHeaders: (res: Response) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    },
  );

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
