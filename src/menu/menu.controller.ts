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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit } from '../common/decorators/audit.decorator';
import {
  CurrentActor,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ReorderDto } from '../common/dto/reorder.dto';
import type { Actor, AuthUser } from '../common/types/request-context';
import { CategoriesService } from './categories.service';
import {
  CreateCategoryDto,
  CreateMenuItemDto,
  ListMenuItemsQueryDto,
  ReorderItemsDto,
  UpdateAvailabilityDto,
  UpdateCategoryDto,
  UpdateMenuItemDto,
} from './dto/menu.dto';
import { ItemsService } from './items.service';

@ApiTags('Menu')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/menu')
export class MenuController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly items: ItemsService,
  ) {}

  // ───────────── Catégories ─────────────

  @Get('categories')
  @RequirePermissions('menu.view')
  listCategories(@Param('restaurantId') restaurantId: string) {
    return this.categories.list(restaurantId);
  }

  @Post('categories')
  @RequirePermissions('menu.manage')
  @Audit('menu.category_create', 'Category')
  createCategory(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.categories.create(restaurantId, dto, user.id);
  }

  // Déclarée avant ':categoryId' pour ne pas être capturée par ce paramètre.
  @Put('categories/reorder')
  @RequirePermissions('menu.manage')
  reorderCategories(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.categories.reorder(restaurantId, dto.ids);
  }

  @Patch('categories/:categoryId')
  @RequirePermissions('menu.manage')
  @Audit('menu.category_update', 'Category')
  updateCategory(
    @Param('restaurantId') restaurantId: string,
    @Param('categoryId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(restaurantId, id, dto);
  }

  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('menu.manage')
  @Audit('menu.category_delete', 'Category')
  removeCategory(
    @Param('restaurantId') restaurantId: string,
    @Param('categoryId', ParseUUIDPipe) id: string,
  ) {
    return this.categories.remove(restaurantId, id);
  }

  // ───────────── Articles ─────────────

  @Get('items')
  @RequirePermissions('menu.view')
  listItems(
    @Param('restaurantId') restaurantId: string,
    @Query() query: ListMenuItemsQueryDto,
  ) {
    return this.items.list(restaurantId, query);
  }

  @Post('items')
  @RequirePermissions('menu.manage')
  @Audit('menu.item_create', 'MenuItem')
  createItem(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateMenuItemDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.items.create(restaurantId, dto, actor);
  }

  @Put('items/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('menu.manage')
  reorderItems(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: ReorderItemsDto,
  ) {
    return this.items.reorder(restaurantId, dto.categoryId, dto.ids);
  }

  @Get('items/:itemId')
  @RequirePermissions('menu.view')
  findItem(
    @Param('restaurantId') restaurantId: string,
    @Param('itemId', ParseUUIDPipe) id: string,
  ) {
    return this.items.findOne(restaurantId, id);
  }

  @Patch('items/:itemId')
  @RequirePermissions('menu.manage')
  @Audit('menu.item_update', 'MenuItem')
  updateItem(
    @Param('restaurantId') restaurantId: string,
    @Param('itemId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.items.update(restaurantId, id, dto, actor);
  }

  @Patch('items/:itemId/availability')
  @RequirePermissions('menu.availability')
  @Audit('menu.item_availability', 'MenuItem')
  updateAvailability(
    @Param('restaurantId') restaurantId: string,
    @Param('itemId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.items.updateAvailability(restaurantId, id, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('menu.manage')
  @Audit('menu.item_delete', 'MenuItem')
  removeItem(
    @Param('restaurantId') restaurantId: string,
    @Param('itemId', ParseUUIDPipe) id: string,
  ) {
    return this.items.remove(restaurantId, id);
  }
}
