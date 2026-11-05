import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { toPublicUser } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';
import type { RequestMeta } from '../common/decorators/request-meta.decorator';
import { paginate, PaginationQueryDto } from '../common/dto/pagination.dto';
import type { OrderLineDto } from '../orders/dto/orders.dto';
import { buildOrderLines } from '../orders/order-lines';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { TERMS_VERSION } from '../privacy/terms';
import type { RegisterCustomerDto } from './customers.controller';

/**
 * Compte client facultatif (CLI-01) : commander reste possible sans
 * inscription ; le compte apporte l'historique, la re-commande (CLI-05) et
 * la fidélité (CLI-02).
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly orders: OrdersService,
  ) {}

  async register(dto: RegisterCustomerDto, meta: RequestMeta) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
      },
      select: { email: true },
    });
    if (existing) {
      throw new ConflictException({
        code: existing.email === dto.email ? 'EMAIL_TAKEN' : 'PHONE_TAKEN',
        message: 'Un compte existe déjà avec ces coordonnées',
      });
    }
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash: await hash(dto.password),
        firstName: dto.firstName,
        lastName: dto.lastName,
        termsAcceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
      },
    });
    return {
      user: toPublicUser(user),
      tokens: await this.tokens.issue(user, meta),
    };
  }

  /** Historique des commandes du client, tous établissements confondus. */
  async myOrders(userId: string, query: PaginationQueryDto) {
    const where = { customerId: userId };
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          items: { orderBy: [{ batch: 'asc' }, { position: 'asc' }] },
          table: { select: { id: true, label: true } },
          restaurant: { select: { name: true, slug: true, logoUrl: true } },
          review: { select: { rating: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(
      orders.map((o) => ({
        ...this.orders.toCustomerView(o),
        restaurant: o.restaurant,
        reviewed: !!o.review,
        trackingToken: this.orders.trackingToken(o.id),
      })),
      total,
      query,
    );
  }

  /**
   * « Commander à nouveau » (CLI-05) : reconstruit le panier d'une commande
   * passée à partir du menu actuel. Les articles retirés, épuisés ou dont les
   * options ont changé sont signalés au lieu d'être ajoutés.
   */
  async reorder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: [{ batch: 'asc' }, { position: 'asc' }] },
        restaurant: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.customerId !== userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_ORDER',
        message: 'Cette commande n’est pas rattachée à votre compte',
      });
    }

    const menuItems = await this.prisma.menuItem.findMany({
      where: {
        id: { in: order.items.map((i) => i.menuItemId) },
        restaurantId: order.restaurantId,
        deletedAt: null,
        isActive: true,
        category: { deletedAt: null, isActive: true },
      },
      include: {
        optionGroups: { include: { options: true } },
      },
    });
    const menu = new Map(menuItems.map((m) => [m.id, m]));

    const items: OrderLineDto[] = [];
    const unavailable: { name: string; reason: string }[] = [];
    for (const line of order.items) {
      const cartLine: OrderLineDto = {
        menuItemId: line.menuItemId,
        quantity: line.quantity,
        optionIds: (line.options as { optionId: string }[]).map(
          (o) => o.optionId,
        ),
        ...(line.notes && { notes: line.notes }),
      };
      try {
        // Mêmes règles qu'à la commande : disponibilité, stock, options obligatoires.
        buildOrderLines([cartLine], menu);
        items.push(cartLine);
      } catch (err) {
        const code =
          (err as { getResponse?: () => { code?: string } }).getResponse?.()
            ?.code ?? 'ITEM_UNAVAILABLE';
        unavailable.push({ name: line.name, reason: code });
      }
    }
    return { restaurant: order.restaurant, items, unavailable };
  }
}
