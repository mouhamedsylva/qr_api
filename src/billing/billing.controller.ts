import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BillingCycle } from '@prisma/client';
import { IsEnum, IsString, Length } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthUser } from '../common/types/request-context';
import { BillingService } from './billing.service';

export class ChangePlanDto {
  @IsString()
  @Length(2, 30)
  planCode: string;

  @IsEnum(BillingCycle)
  billingCycle: BillingCycle = BillingCycle.MONTHLY;
}

@ApiTags('Abonnement')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Grille tarifaire publique (page de tarifs, onboarding). */
  @Public()
  @Get('plans')
  plans() {
    return this.billing.listPublicPlans();
  }

  @ApiBearerAuth()
  @Get('subscription')
  subscription(@CurrentUser() user: AuthUser) {
    return this.billing.overview(user.id);
  }

  @ApiBearerAuth()
  @Post('subscription/change')
  @HttpCode(HttpStatus.OK)
  change(@CurrentUser() user: AuthUser, @Body() dto: ChangePlanDto) {
    return this.billing.changePlanAsOwner(
      user.id,
      dto.planCode,
      dto.billingCycle,
    );
  }
}
