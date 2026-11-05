import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  ReqMeta,
  type RequestMeta,
} from '../common/decorators/request-meta.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { AuthUser } from '../common/types/request-context';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { CustomersService } from './customers.service';

export class RegisterCustomerDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(191)
  email: string;

  @Matches(/^(?=.*[A-Za-z])(?=.*\d).{8,128}$/, {
    message:
      'Le mot de passe doit contenir 8 caractères minimum, dont au moins une lettre et un chiffre',
  })
  password: string;

  @IsString()
  @Length(1, 100)
  firstName: string;

  @IsString()
  @Length(1, 100)
  lastName: string;

  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @Equals(true, { message: 'Les conditions générales doivent être acceptées' })
  acceptTerms: boolean;
}

@ApiTags('Clients')
@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly loyalty: LoyaltyService,
  ) {}

  /** Création d'un compte client (sans établissement). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/customers/register')
  register(@Body() dto: RegisterCustomerDto, @ReqMeta() meta: RequestMeta) {
    return this.customers.register(dto, meta);
  }

  @ApiBearerAuth()
  @Get('me/orders')
  myOrders(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.customers.myOrders(user.id, query);
  }

  @ApiBearerAuth()
  @Post('me/orders/:orderId/reorder')
  reorder(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.customers.reorder(user.id, orderId);
  }

  @ApiBearerAuth()
  @Get('me/loyalty')
  myLoyalty(@CurrentUser() user: AuthUser) {
    return this.loyalty.myAccounts(user.id);
  }

  @ApiBearerAuth()
  // « :establishmentId » et non « :restaurantId » : ce paramètre déclencherait le
  // contrôle d'appartenance à l'équipe (TenantGuard), inadapté à un client.
  @Post('me/loyalty/:establishmentId/rewards/:rewardId/redeem')
  redeem(
    @CurrentUser() user: AuthUser,
    @Param('establishmentId', ParseUUIDPipe) restaurantId: string,
    @Param('rewardId', ParseUUIDPipe) rewardId: string,
  ) {
    return this.loyalty.redeem(user.id, restaurantId, rewardId);
  }

  /** Programme de fidélité d'un établissement, visible sans compte. */
  @Public()
  @Get('public/restaurants/:slug/loyalty')
  publicProgram(@Param('slug') slug: string) {
    return this.loyalty.publicProgram(slug);
  }
}
