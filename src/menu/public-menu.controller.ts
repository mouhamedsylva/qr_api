import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PublicMenuService } from './public-menu.service';

@ApiTags('Public')
@Public()
@Controller('public/restaurants')
export class PublicMenuController {
  constructor(private readonly menu: PublicMenuService) {}

  @Get(':slug/menu')
  menuBySlug(@Param('slug') slug: string) {
    return this.menu.bySlug(slug);
  }
}
