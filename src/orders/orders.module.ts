import { Module } from '@nestjs/common';
import { PromotionsModule } from '../promotions/promotions.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { TablesModule } from '../tables/tables.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PublicOrdersController } from './public-orders.controller';

@Module({
  imports: [RestaurantsModule, TablesModule, PromotionsModule],
  controllers: [OrdersController, PublicOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
