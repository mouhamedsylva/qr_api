import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true, // signature des webhooks de paiement
  });
  app.useLogger(app.get(Logger));
  // Derrière le proxy de l'hébergeur : IP réelle du client pour le rate limiting et l'audit.
  app.set('trust proxy', 1);
  configureApp(app);

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}
void bootstrap();
