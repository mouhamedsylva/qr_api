import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentActor,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Tenant } from '../common/decorators/tenant.decorator';
import type {
  Actor,
  AuthUser,
  TenantContext,
} from '../common/types/request-context';
import {
  AddItemsDto,
  CreateStaffOrderDto,
  ListOrdersQueryDto,
  UpdateOrderStatusDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: 'Clé unique par tentative (ex. UUID) — CMD-16',
};

@ApiTags('Commandes')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Historique filtré et paginé (CMD-03). */
  @Get()
  @RequirePermissions('orders.view')
  list(
    @Param('restaurantId') restaurantId: string,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orders.list(restaurantId, query);
  }

  /** Commandes en cours, de la plus ancienne à la plus récente. */
  @Get('active')
  @RequirePermissions('orders.view')
  active(@Param('restaurantId') restaurantId: string) {
    return this.orders.active(restaurantId);
  }

  @Get('export.csv')
  @RequirePermissions('orders.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="commandes.csv"')
  exportCsv(
    @Param('restaurantId') restaurantId: string,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orders.exportCsv(restaurantId, query);
  }

  @Get(':orderId')
  @RequirePermissions('orders.view')
  findOne(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
  ) {
    return this.orders.findOne(restaurantId, id);
  }

  /** Saisie manuelle par le staff (CMD-12). */
  @Post()
  @RequirePermissions('orders.manage')
  @ApiHeader(IDEMPOTENCY_HEADER)
  async create(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateStaffOrderDto,
    @IdempotencyKey() key: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, replayed } = await this.orders.create(
      {
        restaurantId,
        mode: dto.mode,
        source: 'STAFF',
        tableId: dto.tableId,
        createdById: user.id,
      },
      dto,
      key,
    );
    if (replayed) res.status(200).set('Idempotent-Replayed', 'true');
    return order;
  }

  @Post(':orderId/items')
  @RequirePermissions('orders.manage')
  @ApiHeader(IDEMPOTENCY_HEADER)
  addItems(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: AddItemsDto,
    @IdempotencyKey() key: string,
  ) {
    return this.orders.addItems(restaurantId, id, dto.items, key);
  }

  /** Avance dans le workflow ; l'annulation exige en plus `orders.cancel`. */
  @Patch(':orderId/status')
  @RequirePermissions('orders.manage')
  updateStatus(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
    @Tenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
  ) {
    if (
      dto.status === 'CANCELLED' &&
      !tenant.permissions.has('orders.cancel')
    ) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Permission refusée',
        details: { missing: ['orders.cancel'] },
      });
    }
    return this.orders.transition(restaurantId, id, dto.status, {
      by: 'STAFF',
      reason: dto.reason,
      actor,
    });
  }
}
