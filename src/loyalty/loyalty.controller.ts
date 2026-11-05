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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit } from '../common/decorators/audit.decorator';
import { CurrentActor } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../common/decorators/feature.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { Actor } from '../common/types/request-context';
import {
  AdjustPointsDto,
  CreateRewardDto,
  UpdateRewardDto,
  UpsertLoyaltyProgramDto,
} from './dto/loyalty.dto';
import { LoyaltyService } from './loyalty.service';

/** Gestion du programme de fidélité par l'établissement (CLI-02). */
@ApiTags('Fidélité')
@ApiBearerAuth()
@RequirePermissions('marketing.manage')
@RequireFeature('loyalty')
@Controller('restaurants/:restaurantId/loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  program(@Param('restaurantId') restaurantId: string) {
    return this.loyalty.getProgram(restaurantId);
  }

  @Put()
  @Audit('loyalty.program_update', 'LoyaltyProgram')
  upsertProgram(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: UpsertLoyaltyProgramDto,
  ) {
    return this.loyalty.upsertProgram(restaurantId, dto);
  }

  @Post('rewards')
  @Audit('loyalty.reward_create', 'LoyaltyReward')
  createReward(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateRewardDto,
  ) {
    return this.loyalty.createReward(restaurantId, dto);
  }

  @Patch('rewards/:rewardId')
  updateReward(
    @Param('restaurantId') restaurantId: string,
    @Param('rewardId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRewardDto,
  ) {
    return this.loyalty.updateReward(restaurantId, id, dto);
  }

  @Delete('rewards/:rewardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeReward(
    @Param('restaurantId') restaurantId: string,
    @Param('rewardId', ParseUUIDPipe) id: string,
  ) {
    return this.loyalty.removeReward(restaurantId, id);
  }

  @Get('accounts')
  accounts(@Param('restaurantId') restaurantId: string) {
    return this.loyalty.listAccounts(restaurantId);
  }

  @Post('adjustments')
  adjust(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: AdjustPointsDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.loyalty.adjust(restaurantId, dto, actor);
  }
}
