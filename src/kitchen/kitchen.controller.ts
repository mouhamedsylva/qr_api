import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequireFeature } from '../common/decorators/feature.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  BumpDto,
  CreateStationDto,
  RushDto,
  TicketsQueryDto,
  UpdateItemStatusDto,
  UpdateStationDto,
} from './dto/kitchen.dto';
import { KitchenService } from './kitchen.service';

/** Cuisine : postes, tickets et avancement (module 11), forfait Premium. */
@ApiTags('Cuisine')
@ApiBearerAuth()
@RequireFeature('kds')
@Controller('restaurants/:restaurantId/kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('stations')
  @RequirePermissions('orders.view')
  stations(@Param('restaurantId') restaurantId: string) {
    return this.kitchen.listStations(restaurantId);
  }

  @Post('stations')
  @RequirePermissions('menu.manage')
  createStation(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateStationDto,
  ) {
    return this.kitchen.createStation(restaurantId, dto);
  }

  @Patch('stations/:stationId')
  @RequirePermissions('menu.manage')
  updateStation(
    @Param('restaurantId') restaurantId: string,
    @Param('stationId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStationDto,
  ) {
    return this.kitchen.updateStation(restaurantId, id, dto);
  }

  @Delete('stations/:stationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('menu.manage')
  removeStation(
    @Param('restaurantId') restaurantId: string,
    @Param('stationId', ParseUUIDPipe) id: string,
  ) {
    return this.kitchen.removeStation(restaurantId, id);
  }

  @Get('tickets')
  @RequirePermissions('orders.view')
  tickets(
    @Param('restaurantId') restaurantId: string,
    @Query() query: TicketsQueryDto,
  ) {
    return this.kitchen.tickets(restaurantId, query);
  }

  @Patch('items/:orderItemId')
  @RequirePermissions('orders.manage')
  updateItem(
    @Param('restaurantId') restaurantId: string,
    @Param('orderItemId', ParseUUIDPipe) orderItemId: string,
    @Body() dto: UpdateItemStatusDto,
  ) {
    return this.kitchen.updateItem(restaurantId, orderItemId, dto.status);
  }

  @Post('orders/:orderId/bump')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  bump(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: BumpDto,
  ) {
    return this.kitchen.bump(restaurantId, orderId, dto.stationId, dto.status);
  }

  @Patch('orders/:orderId/rush')
  @RequirePermissions('orders.manage')
  rush(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: RushDto,
  ) {
    return this.kitchen.setRush(restaurantId, orderId, dto.isRush);
  }
}
