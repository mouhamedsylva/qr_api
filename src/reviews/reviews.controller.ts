import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ReviewStatus } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentActor } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Actor } from '../common/types/request-context';
import { verifyOrderToken } from '../orders/order-token';
import { ReviewsService } from './reviews.service';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class ReplyReviewDto {
  @IsString()
  @Length(2, 2000)
  reply: string;
}

export class ModerateReviewDto {
  @IsEnum(ReviewStatus)
  status: ReviewStatus;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  reason?: string;
}

/** Gestion des avis par l'établissement. */
@ApiTags('Avis')
@ApiBearerAuth()
@RequirePermissions('reviews.manage')
@Controller('restaurants/:restaurantId/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(
    @Param('restaurantId') restaurantId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.reviews.list(restaurantId, query);
  }

  @Post(':reviewId/reply')
  reply(
    @Param('restaurantId') restaurantId: string,
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() dto: ReplyReviewDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.reviews.reply(restaurantId, id, dto.reply, actor);
  }

  @Patch(':reviewId/status')
  moderate(
    @Param('restaurantId') restaurantId: string,
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() dto: ModerateReviewDto,
    @CurrentActor() actor: Actor,
  ) {
    if (dto.status === 'HIDDEN' && !dto.reason) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Un motif est obligatoire pour masquer un avis',
      });
    }
    return this.reviews.setStatus(
      restaurantId,
      id,
      dto.status,
      dto.reason,
      actor,
    );
  }
}

/** Avis côté client (PWA). */
@ApiTags('Public')
@Public()
@Controller('public')
export class PublicReviewsController {
  private readonly tokenSecret: string;

  constructor(
    private readonly reviews: ReviewsService,
    config: ConfigService,
  ) {
    this.tokenSecret = config.getOrThrow<string>('QR_SIGNING_SECRET');
  }

  @Get('restaurants/:slug/reviews')
  list(@Param('slug') slug: string, @Query() query: PaginationQueryDto) {
    return this.reviews.publicList(slug, query);
  }

  @Post('orders/:orderId/review')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Order-Token', required: true })
  create(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateReviewDto,
    @Headers('x-order-token') token?: string,
  ) {
    if (!verifyOrderToken(this.tokenSecret, orderId, token)) {
      throw new NotFoundException('Commande introuvable');
    }
    return this.reviews.createForOrder(orderId, dto.rating, dto.comment);
  }
}
