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
import { Throttle } from '@nestjs/throttler';
import {
  CurrentActor,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  ReqMeta,
  type RequestMeta,
} from '../common/decorators/request-meta.decorator';
import { Tenant } from '../common/decorators/tenant.decorator';
import type {
  Actor,
  AuthUser,
  TenantContext,
} from '../common/types/request-context';
import {
  AcceptInvitationDto,
  InviteMemberDto,
  UpdateMemberDto,
} from './dto/team.dto';
import { TeamService } from './team.service';

@ApiTags('Équipe')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @RequirePermissions('team.view')
  members(@Param('restaurantId') restaurantId: string) {
    return this.team.listMembers(restaurantId);
  }

  @Patch('members/:membershipId')
  @RequirePermissions('team.manage')
  updateMember(
    @Param('restaurantId') restaurantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateMemberDto,
    @Tenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
  ) {
    return this.team.updateMember(
      restaurantId,
      membershipId,
      dto,
      tenant,
      actor,
    );
  }

  @Delete('members/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('team.manage')
  removeMember(
    @Param('restaurantId') restaurantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Tenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
  ) {
    return this.team.removeMember(restaurantId, membershipId, tenant, actor);
  }

  @Get('invitations')
  @RequirePermissions('team.view')
  invitations(@Param('restaurantId') restaurantId: string) {
    return this.team.listInvitations(restaurantId);
  }

  @Post('invitations')
  @RequirePermissions('team.manage')
  invite(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: InviteMemberDto,
    @Tenant() tenant: TenantContext,
    @CurrentActor() actor: Actor,
  ) {
    return this.team.invite(restaurantId, dto, tenant, actor);
  }

  @Delete('invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('team.manage')
  revokeInvitation(
    @Param('restaurantId') restaurantId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ) {
    return this.team.revokeInvitation(restaurantId, invitationId);
  }
}

/** Acceptation d'une invitation depuis le lien reçu. */
@ApiTags('Équipe')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly team: TeamService) {}

  @Public()
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.team.preview(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/register')
  acceptAsNewUser(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.team.acceptAsNewUser(token, dto, meta);
  }

  @ApiBearerAuth()
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.team.acceptAsExistingUser(token, user.id);
  }
}
