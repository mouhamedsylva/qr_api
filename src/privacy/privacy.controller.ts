import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsPhoneNumber, IsString, MaxLength, MinLength } from 'class-validator';
import {
  CurrentActor,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { Actor, AuthUser } from '../common/types/request-context';
import { PrivacyService } from './privacy.service';
import { TERMS_VERSION } from './terms';

export class DeleteAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class AnonymizeCustomerDto {
  @IsPhoneNumber()
  phone: string;
}

@ApiTags('Confidentialité')
@ApiBearerAuth()
@Controller()
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** Version en vigueur des CGU (le front affiche le texte correspondant). */
  @Get('privacy/terms-version')
  termsVersion() {
    return { version: TERMS_VERSION };
  }

  @Get('auth/me/export')
  @Header(
    'Content-Disposition',
    'attachment; filename="mes-donnees-qr-order.json"',
  )
  export(@CurrentUser() user: AuthUser) {
    return this.privacy.exportUserData(user.id);
  }

  @Delete('auth/me')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteAccountDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.privacy.deleteAccount(user.id, dto.password, actor);
  }

  @Post('restaurants/:restaurantId/privacy/anonymize-customer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('restaurant.settings')
  anonymizeCustomer(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: AnonymizeCustomerDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.privacy.anonymizeCustomer(restaurantId, dto.phone, actor);
  }
}
