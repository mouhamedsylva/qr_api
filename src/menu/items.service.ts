import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { paginate } from '../common/dto/pagination.dto';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { assertStation } from './station.util';
import { RealtimeEvents } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { isItemAvailable } from './availability';
import {
  CreateMenuItemDto,
  ListMenuItemsQueryDto,
  OptionGroupDto,
  UpdateAvailabilityDto,
  UpdateMenuItemDto,
} from './dto/menu.dto';

export const ITEM_INCLUDE = {
  optionGroups: {
    orderBy: { position: 'asc' },
    include: { options: { orderBy: { position: 'asc' } } },
  },
} satisfies Prisma.MenuItemInclude;

type ItemWithOptions = Prisma.MenuItemGetPayload<{
  include: typeof ITEM_INCLUDE;
}>;

/** Ajoute la disponibilité effective calculée. */
export function withAvailability<
  T extends Parameters<typeof isItemAvailable>[0],
>(item: T, now = new Date()) {
  return { ...item, available: isItemAvailable(item, now) };
}

const SORTABLE = ['position', 'name', 'priceAmount', 'createdAt'] as const;

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(restaurantId: string, query: ListMenuItemsQueryDto) {
    const where: Prisma.MenuItemWhereInput = {
      restaurantId,
      deletedAt: null,
      ...(query.categoryId && { categoryId: query.categoryId }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.search && { name: { contains: query.search } }),
    };
    // Sans tri explicite : ordre d'affichage défini par le restaurateur (MEN-05).
    const sortField = SORTABLE.find((s) => s === query.sort);
    const sort = sortField ?? 'position';
    const order = sortField ? query.order : 'asc';
    const [items, total] = await this.prisma.$transaction([
      this.prisma.menuItem.findMany({
        where,
        include: ITEM_INCLUDE,
        orderBy: [{ [sort]: order }, { createdAt: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.menuItem.count({ where }),
    ]);
    const now = new Date();
    return paginate(
      items.map((i) => withAvailability(i, now)),
      total,
      query,
    );
  }

  async findOne(restaurantId: string, id: string) {
    return withAvailability(await this.getOrThrow(restaurantId, id));
  }

  async create(restaurantId: string, dto: CreateMenuItemDto, actor: Actor) {
    await this.assertCategory(restaurantId, dto.categoryId);
    await assertStation(this.prisma, restaurantId, dto.stationId);
    const { optionGroups, ...data } = dto;
    const last = await this.prisma.menuItem.aggregate({
      where: { categoryId: dto.categoryId, deletedAt: null },
      _max: { position: true },
    });
    const item = await this.prisma.menuItem.create({
      data: {
        ...data,
        restaurantId,
        position: (last._max.position ?? -1) + 1,
        createdById: actor.id,
        optionGroups: { create: toOptionGroupsInput(optionGroups ?? []) },
      },
      include: ITEM_INCLUDE,
    });
    return withAvailability(item);
  }

  /**
   * Mise à jour d'un article. Les groupes d'options fournis remplacent les
   * existants (les commandes conservent un instantané des options choisies).
   * Les changements de prix sont journalisés (CON-04).
   */
  async update(
    restaurantId: string,
    id: string,
    dto: UpdateMenuItemDto,
    actor: Actor,
  ) {
    const before = await this.getOrThrow(restaurantId, id);
    await assertStation(this.prisma, restaurantId, dto.stationId);
    if (dto.categoryId && dto.categoryId !== before.categoryId) {
      await this.assertCategory(restaurantId, dto.categoryId);
    }
    const { optionGroups, ...data } = dto;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (optionGroups) {
        await tx.optionGroup.deleteMany({ where: { menuItemId: id } });
      }
      return tx.menuItem.update({
        where: { id },
        data: {
          ...data,
          ...(optionGroups && {
            optionGroups: { create: toOptionGroupsInput(optionGroups) },
          }),
        },
        include: ITEM_INCLUDE,
      });
    });

    if (
      dto.priceAmount !== undefined &&
      dto.priceAmount !== before.priceAmount
    ) {
      await this.audit.log({
        action: 'menu.price_change',
        entity: 'MenuItem',
        entityId: id,
        restaurantId,
        actorId: actor.id,
        before: { priceAmount: before.priceAmount },
        after: { priceAmount: updated.priceAmount },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }
    return withAvailability(updated);
  }

  /** Épuisé / disponible instantanément, stock limité (MEN-04). */
  async updateAvailability(
    restaurantId: string,
    id: string,
    dto: UpdateAvailabilityDto,
  ) {
    await this.getOrThrow(restaurantId, id);
    const data: Prisma.MenuItemUpdateInput = {};
    if (dto.isAvailable !== undefined) {
      data.isAvailable = dto.isAvailable;
      if (dto.isAvailable) data.availableAgainAt = null;
    }
    if (dto.availableAgainAt !== undefined) {
      data.availableAgainAt = dto.availableAgainAt
        ? new Date(dto.availableAgainAt)
        : null;
    }
    if (dto.stockQuantity !== undefined) {
      data.stockQuantity = dto.stockQuantity;
    }
    const item = withAvailability(
      await this.prisma.menuItem.update({
        where: { id },
        data,
        include: ITEM_INCLUDE,
      }),
    );
    await this.realtime.emit({
      restaurantId,
      type: RealtimeEvents.MenuItemUpdated,
      payload: {
        id: item.id,
        name: item.name,
        available: item.available,
        stockQuantity: item.stockQuantity,
        availableAgainAt: item.availableAgainAt,
      },
    });
    return item;
  }

  async remove(restaurantId: string, id: string) {
    await this.getOrThrow(restaurantId, id);
    await this.prisma.menuItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Réordonne les articles d'une catégorie (MEN-05). */
  async reorder(restaurantId: string, categoryId: string, ids: string[]) {
    await this.assertCategory(restaurantId, categoryId);
    const count = await this.prisma.menuItem.count({
      where: { id: { in: ids }, restaurantId, categoryId, deletedAt: null },
    });
    if (count !== ids.length) {
      throw new BadRequestException({
        code: 'INVALID_IDS',
        message: "Certains articles n'appartiennent pas à cette catégorie",
      });
    }
    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.menuItem.update({ where: { id }, data: { position } }),
      ),
    );
  }

  private async getOrThrow(
    restaurantId: string,
    id: string,
  ): Promise<ItemWithOptions> {
    const item = await this.prisma.menuItem.findFirst({
      where: { id, restaurantId, deletedAt: null },
      include: ITEM_INCLUDE,
    });
    if (!item) {
      throw new NotFoundException('Article introuvable');
    }
    return item;
  }

  /** Empêche de rattacher un article à la catégorie d'un autre restaurant. */
  private async assertCategory(restaurantId: string, categoryId: string) {
    const exists = await this.prisma.category.count({
      where: { id: categoryId, restaurantId, deletedAt: null },
    });
    if (!exists) {
      throw new BadRequestException({
        code: 'INVALID_CATEGORY',
        message: 'Catégorie introuvable',
      });
    }
  }
}

/**
 * Normalise et valide les groupes d'options (MEN-03) :
 * un groupe obligatoire exige au moins 1 choix, et min ≤ max ≤ nombre d'options.
 */
export function toOptionGroupsInput(
  groups: OptionGroupDto[],
): Prisma.OptionGroupCreateWithoutMenuItemInput[] {
  return groups.map((group, position) => {
    const isRequired = group.isRequired ?? false;
    const minSelect = Math.max(group.minSelect ?? 0, isRequired ? 1 : 0);
    const maxSelect = group.maxSelect ?? Math.max(1, minSelect);
    if (group.options.length === 0) {
      throw invalidGroup(group.name, 'au moins une option est requise');
    }
    if (minSelect > maxSelect) {
      throw invalidGroup(group.name, 'minSelect doit être ≤ maxSelect');
    }
    if (maxSelect > group.options.length) {
      throw invalidGroup(
        group.name,
        'maxSelect ne peut pas dépasser le nombre d’options',
      );
    }
    return {
      name: group.name,
      isRequired,
      minSelect,
      maxSelect,
      position,
      options: {
        create: group.options.map((option, optionPosition) => ({
          name: option.name,
          priceDelta: option.priceDelta ?? 0,
          isAvailable: option.isAvailable ?? true,
          position: optionPosition,
        })),
      },
    };
  });
}

function invalidGroup(name: string, reason: string) {
  return new BadRequestException({
    code: 'INVALID_OPTION_GROUP',
    message: `Groupe d'options « ${name} » : ${reason}`,
  });
}
