import { Injectable, NotFoundException } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { isItemAvailable } from './availability';

/** Menu affiché au client (PWA) : uniquement le contenu actif, sans données internes. */
@Injectable()
export class PublicMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async bySlug(slug: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, currency: true },
    });
    if (!restaurant) {
      throw new NotFoundException('Restaurant introuvable');
    }
    await this.billing.assertRestaurantInService(restaurant.id);
    return this.forRestaurant(restaurant.id, restaurant.currency);
  }

  async forRestaurant(restaurantId: string, currency: string) {
    const [categories, items] = await Promise.all([
      this.prisma.category.findMany({
        where: { restaurantId, deletedAt: null, isActive: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          parentId: true,
          name: true,
          description: true,
          imageUrl: true,
        },
      }),
      this.prisma.menuItem.findMany({
        where: { restaurantId, deletedAt: null, isActive: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          categoryId: true,
          name: true,
          description: true,
          priceAmount: true,
          images: true,
          prepTimeMinutes: true,
          allergens: true,
          dietaryTags: true,
          calories: true,
          isAvailable: true,
          availableAgainAt: true,
          stockQuantity: true,
          optionGroups: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              name: true,
              isRequired: true,
              minSelect: true,
              maxSelect: true,
              options: {
                orderBy: { position: 'asc' },
                select: {
                  id: true,
                  name: true,
                  priceDelta: true,
                  isAvailable: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const now = new Date();
    // Colonnes JSON facultatives : toujours des listes pour le client.
    const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
    const publicItems = items.map(
      ({ isAvailable, availableAgainAt, stockQuantity, ...item }) => ({
        ...item,
        images: list(item.images),
        allergens: list(item.allergens),
        dietaryTags: list(item.dietaryTags),
        available: isItemAvailable(
          { isAvailable, availableAgainAt, stockQuantity },
          now,
        ),
      }),
    );
    const itemsOf = (categoryId: string) =>
      publicItems.filter((i) => i.categoryId === categoryId);

    // Les sous-catégories d'une catégorie inactive sont masquées avec elle.
    const tree = categories
      .filter((c) => c.parentId === null)
      .map((parent) => ({
        ...parent,
        items: itemsOf(parent.id),
        children: categories
          .filter((c) => c.parentId === parent.id)
          .map((child) => ({ ...child, items: itemsOf(child.id) })),
      }))
      .filter((c) => c.items.length || c.children.some((s) => s.items.length));

    return { currency, categories: tree };
  }
}
