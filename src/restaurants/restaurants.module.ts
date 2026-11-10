import { Module } from '@nestjs/common';
import { PublicRestaurantsController } from './public-restaurants.controller';
import { RestaurantsController } from './restaurants.controller';
import { RestaurantImagesController } from './restaurant-images.controller';
import { RestaurantsService } from './restaurants.service';

@Module({
  controllers: [
    RestaurantsController,
    RestaurantImagesController,
    PublicRestaurantsController,
  ],
  providers: [RestaurantsService],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
