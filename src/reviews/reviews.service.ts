import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReviewStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { paginate, PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';

/** Statuts de commande à partir desquels le client peut donner son avis. */
const REVIEWABLE = ['SERVED', 'COMPLETED'];

const PUBLIC_SELECT = {
  id: true,
  rating: true,
  comment: true,
  authorName: true,
  reply: true,
  repliedAt: true,
  createdAt: true,
} satisfies Prisma.ReviewSelect;

/** Avis et notes (CLI-03) : un avis par commande, réponse et modération. */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Avis déposé par le client, avec le jeton de suivi de sa commande. */
  async createForOrder(
    orderId: string,
    rating: number,
    comment: string | undefined,
  ) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        restaurantId: true,
        status: true,
        customerId: true,
        customerName: true,
        customer: { select: { firstName: true } },
      },
    });
    if (!REVIEWABLE.includes(order.status)) {
      throw new ConflictException({
        code: 'ORDER_NOT_REVIEWABLE',
        message: 'Vous pourrez donner votre avis une fois la commande servie',
      });
    }
    try {
      return await this.prisma.review.create({
        data: {
          restaurantId: order.restaurantId,
          orderId,
          customerId: order.customerId,
          authorName: order.customer?.firstName ?? order.customerName ?? null,
          rating,
          comment: comment?.trim() || null,
        },
        select: PUBLIC_SELECT,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'ALREADY_REVIEWED',
          message: 'Vous avez déjà donné votre avis sur cette commande',
        });
      }
      throw err;
    }
  }

  /** Avis publiés d'un établissement, avec la note moyenne et la répartition. */
  async publicList(slug: string, query: PaginationQueryDto) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant introuvable');
    const where = {
      restaurantId: restaurant.id,
      status: ReviewStatus.PUBLISHED,
    };
    const [reviews, total, stats, distribution] = await Promise.all([
      this.prisma.review.findMany({
        where,
        select: PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.aggregate({ where, _avg: { rating: true } }),
      this.prisma.review.groupBy({ by: ['rating'], where, _count: true }),
    ]);
    return {
      averageRating:
        stats._avg.rating === null
          ? null
          : Math.round(stats._avg.rating * 10) / 10,
      distribution: Object.fromEntries(
        [5, 4, 3, 2, 1].map((r) => [
          r,
          distribution.find((d) => d.rating === r)?._count ?? 0,
        ]),
      ),
      ...paginate(reviews, total, query),
    };
  }

  /** Tous les avis (y compris masqués) pour l'établissement. */
  async list(restaurantId: string, query: PaginationQueryDto) {
    const where = { restaurantId };
    const [reviews, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        include: { order: { select: { number: true } } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.review.count({ where }),
    ]);
    return paginate(reviews, total, query);
  }

  async reply(restaurantId: string, id: string, reply: string, actor: Actor) {
    await this.getOrThrow(restaurantId, id);
    return this.prisma.review.update({
      where: { id },
      data: { reply, repliedAt: new Date(), repliedById: actor.id },
    });
  }

  /** Modération : masquer (avec motif) ou republier un avis. */
  async setStatus(
    restaurantId: string,
    id: string,
    status: ReviewStatus,
    reason: string | undefined,
    actor: Actor,
  ) {
    const review = await this.getOrThrow(restaurantId, id);
    const updated = await this.prisma.review.update({
      where: { id },
      data: { status, hiddenReason: status === 'HIDDEN' ? reason : null },
    });
    await this.audit.log({
      action: status === 'HIDDEN' ? 'reviews.hide' : 'reviews.publish',
      entity: 'Review',
      entityId: id,
      restaurantId,
      actorId: actor.id,
      before: { status: review.status },
      after: { status, reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return updated;
  }

  private async getOrThrow(restaurantId: string, id: string) {
    const review = await this.prisma.review.findFirst({
      where: { id, restaurantId },
    });
    if (!review) throw new NotFoundException('Avis introuvable');
    return review;
  }
}
