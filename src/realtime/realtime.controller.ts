import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { RealtimeService } from './realtime.service';

export class EventsQueryDto {
  /** Dernier numéro de séquence reçu (0 pour tout recevoir). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 200;
}

/** Rattrapage après reconnexion et repli par polling (NOT-06). */
@ApiTags('Temps réel')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/events')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get()
  @RequirePermissions('orders.view')
  since(
    @Param('restaurantId') restaurantId: string,
    @Query() query: EventsQueryDto,
  ) {
    return this.realtime.since(restaurantId, query.after, query.limit);
  }
}
