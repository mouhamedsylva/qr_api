import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthUser } from '../common/types/request-context';
import { EventsQueryDto } from '../realtime/realtime.controller';
import {
  AddItemsDto,
  CreatePublicOrderDto,
  CustomerCancelDto,
} from './dto/orders.dto';
import { verifyOrderToken } from './order-token';
import { OrdersService } from './orders.service';
import { ConfigService } from '@nestjs/config';

const ORDER_TOKEN_HEADER = {
  name: 'X-Order-Token',
  required: true,
  description: 'Jeton de suivi renvoyé à la création de la commande',
};

/**
 * Parcours client anonyme (PWA) : commande, suivi, ajout d'articles,
 * annulation. L'accès à une commande exige son jeton de suivi.
 */
@ApiTags('Public')
@Public()
@Controller('public/orders')
export class PublicOrdersController {
  private readonly tokenSecret: string;

  constructor(
    private readonly orders: OrdersService,
    config: ConfigService,
  ) {
    this.tokenSecret = config.getOrThrow<string>('QR_SIGNING_SECRET');
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(
    @Body() dto: CreatePublicOrderDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: AuthUser,
  ) {
    // Client connecté (facultatif) : commande rattachée à son compte (CLI-01).
    const ctx = {
      ...(await this.orders.resolvePublicContext(dto)),
      customerId: user?.id ?? null,
    };
    const { order, replayed } = await this.orders.create(ctx, dto, key);
    if (replayed) res.status(200).set('Idempotent-Replayed', 'true');
    return {
      order: this.orders.toCustomerView(order),
      trackingToken: this.orders.trackingToken(order.id),
    };
  }

  /** Récapitulatif du panier avant validation : remise, taxes, total (CMD-04). */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async quote(
    @Body() dto: CreatePublicOrderDto,
    @CurrentUser() user?: AuthUser,
  ) {
    const ctx = {
      ...(await this.orders.resolvePublicContext(dto)),
      customerId: user?.id ?? null,
    };
    return this.orders.quote(ctx, dto);
  }

  @Get(':orderId')
  @ApiHeader(ORDER_TOKEN_HEADER)
  async findOne(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(id, token);
    return this.orders.toCustomerView(await this.orders.findForCustomer(id));
  }

  /** Repli par polling quand le WebSocket est indisponible (NOT-06). */
  @Get(':orderId/events')
  @ApiHeader(ORDER_TOKEN_HEADER)
  events(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Query() query: EventsQueryDto,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(id, token);
    return this.orders.customerEvents(id, query.after);
  }

  /** Commande additionnelle depuis la table (CMD-06). */
  @Post(':orderId/items')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader(ORDER_TOKEN_HEADER)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async addItems(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: AddItemsDto,
    @IdempotencyKey() key: string,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(id, token);
    const order = await this.orders.findForCustomer(id);
    return this.orders.toCustomerView(
      await this.orders.addItems(order.restaurantId, id, dto.items, key),
    );
  }

  /** Annulation par le client, tant que la commande n'est pas acceptée (CMD-08). */
  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(ORDER_TOKEN_HEADER)
  async cancel(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: CustomerCancelDto,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(id, token);
    const order = await this.orders.findForCustomer(id);
    return this.orders.toCustomerView(
      await this.orders.transition(order.restaurantId, id, 'CANCELLED', {
        by: 'CUSTOMER',
        reason: dto.reason,
      }),
    );
  }

  /** Jeton invalide : 404, pour ne pas confirmer l'existence de la commande. */
  private assertToken(orderId: string, token?: string) {
    if (!verifyOrderToken(this.tokenSecret, orderId, token)) {
      throw new NotFoundException('Commande introuvable');
    }
  }
}
