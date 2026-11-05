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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../common/decorators/feature.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthUser } from '../common/types/request-context';
import { CreatePromotionDto, UpdatePromotionDto } from './dto/promotions.dto';
import { PromotionsService } from './promotions.service';

@ApiTags('Promotions')
@ApiBearerAuth()
@RequirePermissions('marketing.manage')
@RequireFeature('promotions')
@Controller('restaurants/:restaurantId/promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  list(@Param('restaurantId') restaurantId: string) {
    return this.promotions.list(restaurantId);
  }

  @Post()
  @Audit('promotions.create', 'Promotion')
  create(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreatePromotionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.promotions.create(restaurantId, dto, user.id);
  }

  @Patch(':promotionId')
  @Audit('promotions.update', 'Promotion')
  update(
    @Param('restaurantId') restaurantId: string,
    @Param('promotionId', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    return this.promotions.update(restaurantId, id, dto);
  }

  @Delete(':promotionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('promotions.delete', 'Promotion')
  remove(
    @Param('restaurantId') restaurantId: string,
    @Param('promotionId', ParseUUIDPipe) id: string,
  ) {
    return this.promotions.remove(restaurantId, id);
  }
}
