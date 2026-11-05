import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditQueryService } from '../audit/audit-query.service';
import { CurrentActor } from '../common/decorators/current-user.decorator';
import { SuperAdminOnly } from '../common/decorators/super-admin.decorator';
import type { Actor } from '../common/types/request-context';
import { AdminService } from './admin.service';
import {
  AuditQueryDto,
  CreatePlanDto,
  ListRestaurantsQueryDto,
  ModerateRestaurantDto,
  ModerateUserDto,
  UpdatePlanDto,
  UpdateSubscriptionDto,
} from './dto/admin.dto';

/** Administration de la plateforme (module 9), réservée aux super-admins. */
@ApiTags('Administration')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditQueryService,
  ) {}

  @Get('restaurants')
  restaurants(@Query() query: ListRestaurantsQueryDto) {
    return this.admin.listRestaurants(query);
  }

  @Patch('restaurants/:id/status')
  moderateRestaurant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateRestaurantDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.admin.setRestaurantStatus(id, dto.status, dto.reason, actor);
  }

  @Patch('users/:id/status')
  moderateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateUserDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.admin.setUserStatus(id, dto.status, dto.reason, actor);
  }

  @Get('analytics')
  analytics() {
    return this.admin.analytics();
  }

  @Get('plans')
  plans() {
    return this.admin.listPlans();
  }

  @Post('plans')
  createPlan(@Body() dto: CreatePlanDto, @CurrentActor() actor: Actor) {
    return this.admin.createPlan(dto, actor);
  }

  @Patch('plans/:code')
  updatePlan(
    @Param('code') code: string,
    @Body() dto: UpdatePlanDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.admin.updatePlan(code, dto, actor);
  }

  @Patch('subscriptions/:userId')
  updateSubscription(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSubscriptionDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.admin.updateSubscription(userId, dto, actor);
  }

  @Get('audit-logs')
  auditLogs(@Query() query: AuditQueryDto) {
    return this.audit.search(query);
  }
}
