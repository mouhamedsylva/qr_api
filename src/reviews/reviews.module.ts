import { Module } from '@nestjs/common';
import {
  PublicReviewsController,
  ReviewsController,
} from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [ReviewsController, PublicReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
