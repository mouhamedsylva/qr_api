import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeysService } from './api-keys.service';
import {
  IntegrationsController,
  IntegrationToolsController,
} from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { PublicApiController } from './public-api.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [MenuModule, OrdersModule],
  controllers: [
    IntegrationsController,
    IntegrationToolsController,
    PublicApiController,
  ],
  providers: [
    ApiKeysService,
    ApiKeyGuard,
    WebhooksService,
    IntegrationsService,
  ],
  exports: [WebhooksService],
})
export class IntegrationsModule {}
