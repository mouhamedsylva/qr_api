import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertStation } from './station.util';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/menu.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Arborescence des catégories (MEN-01) avec le nombre d'articles. */
  async list(restaurantId: string) {
    const categories = await this.prisma.category.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { items: { where: { deletedAt: null } } } },
      },
    });
    const toNode = (c: (typeof categories)[number]) => {
      const { _count, ...rest } = c;
      return { ...rest, itemsCount: _count.items };
    };
    return categories
      .filter((c) => c.parentId === null)
      .map((parent) => ({
        ...toNode(parent),
        children: categories
          .filter((c) => c.parentId === parent.id)
          .map(toNode),
      }));
  }

  async findOne(restaurantId: string, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, restaurantId, deletedAt: null },
    });
    if (!category) {
      throw new NotFoundException('Catégorie introuvable');
    }
    return category;
  }

  async create(restaurantId: string, dto: CreateCategoryDto, actorId: string) {
    await assertStation(this.prisma, restaurantId, dto.stationId);
    if (dto.parentId) {
      await this.assertValidParent(restaurantId, dto.parentId);
    }
    const position = await this.nextPosition(
      restaurantId,
      dto.parentId ?? null,
    );
    return this.prisma.category.create({
      data: { ...dto, restaurantId, position, createdById: actorId },
    });
  }

  async update(restaurantId: string, id: string, dto: UpdateCategoryDto) {
    await assertStation(this.prisma, restaurantId, dto.stationId);
    await this.findOne(restaurantId, id);
    if (dto.parentId) {
      if (dto.parentId === id) {
        throw invalidParent('Une catégorie ne peut pas être sa propre parente');
      }
      await this.assertValidParent(restaurantId, dto.parentId);
      const hasChildren = await this.prisma.category.count({
        where: { parentId: id, deletedAt: null },
      });
      if (hasChildren) {
        throw invalidParent(
          'Une catégorie ayant des sous-catégories ne peut pas devenir sous-catégorie',
        );
      }
    }
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(restaurantId: string, id: string) {
    await this.findOne(restaurantId, id);
    const [children, items] = await Promise.all([
      this.prisma.category.count({ where: { parentId: id, deletedAt: null } }),
      this.prisma.menuItem.count({
        where: { categoryId: id, deletedAt: null },
      }),
    ]);
    if (children || items) {
      throw new ConflictException({
        code: 'CATEGORY_NOT_EMPTY',
        message:
          'La catégorie contient encore des articles ou des sous-catégories',
        details: { children, items },
      });
    }
    await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Réordonne des catégories (MEN-05) ; toutes doivent appartenir au restaurant. */
  async reorder(restaurantId: string, ids: string[]) {
    const count = await this.prisma.category.count({
      where: { id: { in: ids }, restaurantId, deletedAt: null },
    });
    if (count !== ids.length) {
      throw new BadRequestException({
        code: 'INVALID_IDS',
        message: 'Certaines catégories sont introuvables',
      });
    }
    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.category.update({ where: { id }, data: { position } }),
      ),
    );
    return this.list(restaurantId);
  }

  private async assertValidParent(restaurantId: string, parentId: string) {
    const parent = await this.prisma.category.findFirst({
      where: { id: parentId, restaurantId, deletedAt: null },
    });
    if (!parent) {
      throw invalidParent('Catégorie parente introuvable');
    }
    if (parent.parentId) {
      throw invalidParent('Un seul niveau de sous-catégorie est autorisé');
    }
  }

  private async nextPosition(restaurantId: string, parentId: string | null) {
    const last = await this.prisma.category.aggregate({
      where: { restaurantId, parentId, deletedAt: null },
      _max: { position: true },
    } satisfies Prisma.CategoryAggregateArgs);
    return (last._max.position ?? -1) + 1;
  }
}

function invalidParent(message: string) {
  return new BadRequestException({ code: 'INVALID_PARENT', message });
}
