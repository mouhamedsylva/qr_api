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
import {
  CurrentActor,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { Actor, AuthUser } from '../common/types/request-context';
import {
  CreateClosureDto,
  CreateRestaurantDto,
  SetOpeningHoursDto,
  UpdateBrandingDto,
  UpdateProfileDto,
  UpdateRegionalDto,
  UpdateTaxDto,
} from './dto/restaurant.dto';
import { RestaurantsService } from './restaurants.service';
import { BillingService } from '../billing/billing.service';

/**
 * Toutes les routes `:restaurantId` passent par TenantGuard (appartenance)
 * puis AccessGuard (rôle + permissions).
 */
@ApiTags('Restaurants')
@ApiBearerAuth()
@Controller('restaurants')
export class RestaurantsController {
  constructor(
    private readonly restaurants: RestaurantsService,
    private readonly billing: BillingService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.restaurants.listForUser(user.id);
  }

  /** Ajoute un établissement ; l'utilisateur en devient OWNER (RES-07). */
  @Post()
  create(@Body() dto: CreateRestaurantDto, @CurrentActor() actor: Actor) {
    return this.restaurants.create(dto, actor);
  }

  @Get(':restaurantId')
  @RequirePermissions('restaurant.view')
  async findOne(@Param('restaurantId') id: string) {
    const restaurant = await this.restaurants.findOne(id);
    return {
      ...restaurant,
      // Faux : le back-office affiche l'écran d'abonnement (forfaits) à la place du tableau de bord.
      subscriptionActive: await this.billing.isOwnerEntitled(
        restaurant.ownerId,
      ),
    };
  }

  @Patch(':restaurantId')
  @RequirePermissions('restaurant.update')
  updateProfile(
    @Param('restaurantId') id: string,
    @Body() dto: UpdateProfileDto,
    @CurrentActor() actor: Actor,
  ) {
    const { socialLinks, ...rest } = dto;
    return this.restaurants.update(
      id,
      { ...rest, ...(socialLinks && { socialLinks: { ...socialLinks } }) },
      actor,
      'restaurant.update_profile',
    );
  }

  @Patch(':restaurantId/branding')
  @RequirePermissions('restaurant.update')
  updateBranding(
    @Param('restaurantId') id: string,
    @Body() dto: UpdateBrandingDto,
    @CurrentActor() actor: Actor,
  ) {
    const { brandColors, ...rest } = dto;
    return this.restaurants.update(
      id,
      { ...rest, ...(brandColors && { brandColors: { ...brandColors } }) },
      actor,
      'restaurant.update_branding',
    );
  }

  @Patch(':restaurantId/regional')
  @RequirePermissions('restaurant.settings')
  updateRegional(
    @Param('restaurantId') id: string,
    @Body() dto: UpdateRegionalDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.restaurants.update(
      id,
      { ...dto },
      actor,
      'restaurant.update_regional',
    );
  }

  @Patch(':restaurantId/tax')
  @RequirePermissions('restaurant.settings')
  updateTax(
    @Param('restaurantId') id: string,
    @Body() dto: UpdateTaxDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.restaurants.update(
      id,
      { ...dto },
      actor,
      'restaurant.update_tax',
    );
  }

  @Put(':restaurantId/opening-hours')
  @RequirePermissions('restaurant.settings')
  @Audit('restaurant.set_opening_hours', 'Restaurant')
  setOpeningHours(
    @Param('restaurantId') id: string,
    @Body() dto: SetOpeningHoursDto,
  ) {
    return this.restaurants.setOpeningHours(id, dto);
  }

  @Get(':restaurantId/closures')
  @RequirePermissions('restaurant.view')
  listClosures(@Param('restaurantId') id: string) {
    return this.restaurants.listClosures(id);
  }

  @Post(':restaurantId/closures')
  @RequirePermissions('restaurant.settings')
  @Audit('restaurant.add_closure', 'ClosurePeriod')
  addClosure(
    @Param('restaurantId') id: string,
    @Body() dto: CreateClosureDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.restaurants.addClosure(id, dto, user.id);
  }

  @Delete(':restaurantId/closures/:closureId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('restaurant.settings')
  @Audit('restaurant.remove_closure', 'ClosurePeriod')
  removeClosure(
    @Param('restaurantId') id: string,
    @Param('closureId', ParseUUIDPipe) closureId: string,
  ) {
    return this.restaurants.removeClosure(id, closureId);
  }

  @Get(':restaurantId/is-open')
  @RequirePermissions('restaurant.view')
  isOpen(@Param('restaurantId') id: string) {
    return this.restaurants.openStatus(id);
  }

  @Get(':restaurantId/dashboard')
  @RequirePermissions('dashboard.view')
  dashboard(@Param('restaurantId') id: string) {
    return this.restaurants.dashboard(id);
  }

  @Delete(':restaurantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER')
  @RequirePermissions('restaurant.delete')
  remove(@Param('restaurantId') id: string, @CurrentActor() actor: Actor) {
    return this.restaurants.softDelete(id, actor);
  }
}
