import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { PublicQrController } from './public-qr.controller';
import { QrTokenService } from './qr-token.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

@Module({
  imports: [RestaurantsModule, MenuModule],
  controllers: [TablesController, PublicQrController],
  providers: [TablesService, QrTokenService],
  exports: [TablesService, QrTokenService],
})
export class TablesModule {}
