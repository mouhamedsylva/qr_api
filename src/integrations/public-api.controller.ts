import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { PublicMenuService } from '../menu/public-menu.service';
import {
  ListOrdersQueryDto,
  UpdateOrderStatusDto,
} from '../orders/dto/orders.dto';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ApiClient } from './api-keys.service';
import { ApiKeyGuard, ApiScopes, CurrentApiClient } from './api-key.guard';

/**
 * API publique (INT-01), pour caisses, logiciels de gestion ou intégrateurs.
 * Authentification par en-tête `X-Api-Key` ; l'établissement est déterminé
 * par la clé, jamais par la requête.
 */
@ApiTags('API publique')
@ApiSecurity('api-key')
@Public() // pas de JWT : l'authentification se fait par clé d'API
@SkipThrottle() // quota propre à chaque clé, appliqué par ApiKeyGuard
@UseGuards(ApiKeyGuard)
@Controller('integrations')
export class PublicApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: PublicMenuService,
    private readonly orders: OrdersService,
  ) {}

  /** Identité de la clé : établissement et droits. */
  @Get('me')
  async me(@CurrentApiClient() client: ApiClient) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: client.restaurantId },
      select: {
        id: true,
        name: true,
        slug: true,
        currency: true,
        timezone: true,
      },
    });
    return { restaurant, scopes: client.scopes };
  }

  @Get('menu')
  @ApiScopes('menu:read')
  async getMenu(@CurrentApiClient() client: ApiClient) {
    const { currency } = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: client.restaurantId },
      select: { currency: true },
    });
    return this.menu.forRestaurant(client.restaurantId, currency);
  }

  @Get('orders')
  @ApiScopes('orders:read')
  listOrders(
    @CurrentApiClient() client: ApiClient,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orders.list(client.restaurantId, query);
  }

  @Get('orders/:orderId')
  @ApiScopes('orders:read')
  getOrder(
    @CurrentApiClient() client: ApiClient,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.findOne(client.restaurantId, orderId);
  }

  /** Mise à jour du statut depuis un système tiers (même workflow que le staff). */
  @Patch('orders/:orderId/status')
  @ApiScopes('orders:write')
  updateStatus(
    @CurrentApiClient() client: ApiClient,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orders.transition(client.restaurantId, orderId, dto.status, {
      by: 'STAFF',
      reason: dto.reason,
    });
  }
}
