import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { RestaurantsService } from './restaurants.service';

/** Informations publiques d'un établissement pour la PWA client (sans authentification). */
@ApiTags('Public')
@Public()
@Controller('public/restaurants')
export class PublicRestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}

  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.restaurants.findPublicBySlug(slug);
  }
}
