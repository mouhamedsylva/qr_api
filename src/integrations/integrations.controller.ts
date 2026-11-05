import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../common/decorators/feature.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { AuthUser } from '../common/types/request-context';
import { ApiKeysService } from './api-keys.service';
import {
  CreateApiKeyDto,
  CreateWebhookDto,
  PeriodQueryDto,
  UpdateWebhookDto,
} from './dto/integrations.dto';
import { IntegrationsService } from './integrations.service';
import { WebhooksService } from './webhooks.service';

/** Clés d'API et webhooks d'un établissement (forfait incluant l'API). */
@ApiTags('Intégrations')
@ApiBearerAuth()
@RequirePermissions('integrations.manage')
@RequireFeature('api')
@Controller('restaurants/:restaurantId/integrations')
export class IntegrationsController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ───────────── Clés d'API (INT-01) ─────────────

  @Get('api-keys')
  listKeys(@Param('restaurantId') restaurantId: string) {
    return this.apiKeys.list(restaurantId);
  }

  @Post('api-keys')
  @Audit('integrations.api_key_create', 'ApiKey')
  createKey(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apiKeys.create(restaurantId, dto, user.id);
  }

  @Delete('api-keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('integrations.api_key_revoke', 'ApiKey')
  revokeKey(
    @Param('restaurantId') restaurantId: string,
    @Param('keyId', ParseUUIDPipe) id: string,
  ) {
    return this.apiKeys.revoke(restaurantId, id);
  }

  // ───────────── Webhooks (INT-02) ─────────────

  @Get('webhooks')
  listWebhooks(@Param('restaurantId') restaurantId: string) {
    return this.webhooks.list(restaurantId);
  }

  @Post('webhooks')
  @Audit('integrations.webhook_create', 'WebhookEndpoint')
  createWebhook(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateWebhookDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.webhooks.create(restaurantId, dto, user.id);
  }

  @Patch('webhooks/:endpointId')
  @Audit('integrations.webhook_update', 'WebhookEndpoint')
  updateWebhook(
    @Param('restaurantId') restaurantId: string,
    @Param('endpointId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.webhooks.update(restaurantId, id, dto);
  }

  @Delete('webhooks/:endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('integrations.webhook_delete', 'WebhookEndpoint')
  removeWebhook(
    @Param('restaurantId') restaurantId: string,
    @Param('endpointId', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.remove(restaurantId, id);
  }

  @Post('webhooks/:endpointId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @Audit('integrations.webhook_rotate_secret', 'WebhookEndpoint')
  rotateSecret(
    @Param('restaurantId') restaurantId: string,
    @Param('endpointId', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.rotateSecret(restaurantId, id);
  }

  @Post('webhooks/:endpointId/test')
  @HttpCode(HttpStatus.OK)
  testWebhook(
    @Param('restaurantId') restaurantId: string,
    @Param('endpointId', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.sendTest(restaurantId, id);
  }

  @Get('webhooks/:endpointId/deliveries')
  deliveries(
    @Param('restaurantId') restaurantId: string,
    @Param('endpointId', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.webhooks.deliveries(restaurantId, id, query);
  }

  @Post('webhooks/deliveries/:deliveryId/redeliver')
  @HttpCode(HttpStatus.OK)
  redeliver(
    @Param('restaurantId') restaurantId: string,
    @Param('deliveryId', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.redeliver(restaurantId, id);
  }
}

/** Liens et export comptable, utiles sans l'API publique. */
@ApiTags('Intégrations')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/integrations')
export class IntegrationToolsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /** INT-06 : liens à publier (Google Business, réseaux sociaux). */
  @Get('links')
  @RequirePermissions('restaurant.view')
  links(@Param('restaurantId') restaurantId: string) {
    return this.integrations.links(restaurantId);
  }

  /** INT-04 : journal des ventes et remboursements pour la comptabilité. */
  @Get('accounting-export.csv')
  @RequirePermissions('reports.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="journal-ventes.csv"')
  accountingExport(
    @Param('restaurantId') restaurantId: string,
    @Query() query: PeriodQueryDto,
  ) {
    return this.integrations.accountingExport(
      restaurantId,
      query.from,
      query.to,
    );
  }
}
