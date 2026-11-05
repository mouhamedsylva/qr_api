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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Audit } from '../common/decorators/audit.decorator';
import {
  CurrentActor,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ReorderDto } from '../common/dto/reorder.dto';
import type { Actor, AuthUser } from '../common/types/request-context';
import {
  BulkCreateTablesDto,
  CreateTableDto,
  CreateZoneDto,
  ListTablesQueryDto,
  QrImageQueryDto,
  UpdateTableDto,
  UpdateTableStatusDto,
  UpdateZoneDto,
} from './dto/tables.dto';
import { TablesService } from './tables.service';

@ApiTags('Tables & QR')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  // ───────────── Zones ─────────────

  @Get('zones')
  @RequirePermissions('tables.view')
  listZones(@Param('restaurantId') restaurantId: string) {
    return this.tables.listZones(restaurantId);
  }

  @Post('zones')
  @RequirePermissions('tables.manage')
  @Audit('tables.zone_create', 'Zone')
  createZone(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateZoneDto,
  ) {
    return this.tables.createZone(restaurantId, dto);
  }

  @Patch('zones/:zoneId')
  @RequirePermissions('tables.manage')
  updateZone(
    @Param('restaurantId') restaurantId: string,
    @Param('zoneId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateZoneDto,
  ) {
    return this.tables.updateZone(restaurantId, id, dto);
  }

  @Delete('zones/:zoneId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('tables.manage')
  @Audit('tables.zone_delete', 'Zone')
  removeZone(
    @Param('restaurantId') restaurantId: string,
    @Param('zoneId', ParseUUIDPipe) id: string,
  ) {
    return this.tables.removeZone(restaurantId, id);
  }

  // ───────────── Tables ─────────────

  @Get('tables')
  @RequirePermissions('tables.view')
  list(
    @Param('restaurantId') restaurantId: string,
    @Query() query: ListTablesQueryDto,
  ) {
    return this.tables.list(restaurantId, query);
  }

  @Post('tables')
  @RequirePermissions('tables.manage')
  @Audit('tables.create', 'DiningTable')
  create(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateTableDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tables.create(restaurantId, dto, user.id);
  }

  @Post('tables/bulk')
  @RequirePermissions('tables.manage')
  @Audit('tables.bulk_create', 'DiningTable')
  bulkCreate(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: BulkCreateTablesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tables.bulkCreate(restaurantId, dto, user.id);
  }

  @Put('tables/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('tables.manage')
  reorder(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.tables.reorder(restaurantId, dto.ids);
  }

  @Get('tables/:tableId')
  @RequirePermissions('tables.view')
  findOne(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
  ) {
    return this.tables.findOne(restaurantId, id);
  }

  @Patch('tables/:tableId')
  @RequirePermissions('tables.manage')
  @Audit('tables.update', 'DiningTable')
  update(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTableDto,
  ) {
    return this.tables.update(restaurantId, id, dto);
  }

  @Patch('tables/:tableId/status')
  @RequirePermissions('tables.status')
  updateStatus(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTableStatusDto,
  ) {
    return this.tables.updateStatus(restaurantId, id, dto);
  }

  @Delete('tables/:tableId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('tables.manage')
  @Audit('tables.delete', 'DiningTable')
  remove(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
  ) {
    return this.tables.remove(restaurantId, id);
  }

  // ───────────── QR codes ─────────────

  @Get('tables/:tableId/qr')
  @RequirePermissions('tables.view')
  qrInfo(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
  ) {
    return this.tables.qrInfo(restaurantId, id);
  }

  @Get('tables/:tableId/qr/image')
  @RequirePermissions('tables.view')
  @ApiProduces('image/png', 'image/svg+xml')
  async qrImage(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
    @Query() query: QrImageQueryDto,
    @Res() res: Response,
  ) {
    const image = await this.tables.qrImage(
      restaurantId,
      id,
      query.format,
      query.size,
    );
    // Envoi direct du buffer : Content-Length explicite, réponse terminée de façon déterministe.
    res
      .status(200)
      .set({
        'Content-Type': query.format === 'svg' ? 'image/svg+xml' : 'image/png',
        'Cache-Control': 'no-store',
      })
      .send(image);
  }

  @Post('tables/:tableId/qr/regenerate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('tables.manage')
  regenerateQr(
    @Param('restaurantId') restaurantId: string,
    @Param('tableId', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.tables.regenerateQr(restaurantId, id, actor);
  }
}
