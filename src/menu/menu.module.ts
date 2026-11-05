import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { ItemsService } from './items.service';
import { MenuController } from './menu.controller';
import { PublicMenuController } from './public-menu.controller';
import { PublicMenuService } from './public-menu.service';

@Module({
  controllers: [MenuController, PublicMenuController],
  providers: [CategoriesService, ItemsService, PublicMenuService],
  exports: [ItemsService, PublicMenuService],
})
export class MenuModule {}
