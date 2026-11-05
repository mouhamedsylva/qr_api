import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireFeature } from '../common/decorators/feature.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics.dto';

/** Analytics et rapports (module 12), inclus à partir du forfait Pro. */
@ApiTags('Analytics')
@ApiBearerAuth()
@RequirePermissions('reports.view')
@RequireFeature('analytics')
@Controller('restaurants/:restaurantId/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiProduces('application/json', 'text/csv')
  overview(
    @Param('restaurantId') restaurantId: string,
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return query.format === 'csv'
      ? this.csv(
          res,
          'activite',
          this.analytics.overviewCsv(restaurantId, query),
        )
      : this.analytics.overview(restaurantId, query);
  }

  @Get('menu')
  @ApiProduces('application/json', 'text/csv')
  menu(
    @Param('restaurantId') restaurantId: string,
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return query.format === 'csv'
      ? this.csv(
          res,
          'performance-menu',
          this.analytics.menuPerformanceCsv(restaurantId, query),
        )
      : this.analytics.menuPerformance(restaurantId, query);
  }

  @Get('tax')
  @ApiProduces('application/json', 'text/csv')
  tax(
    @Param('restaurantId') restaurantId: string,
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return query.format === 'csv'
      ? this.csv(
          res,
          'rapport-tva',
          this.analytics.taxReportCsv(restaurantId, query),
        )
      : this.analytics.taxReport(restaurantId, query);
  }

  private async csv(res: Response, name: string, content: Promise<string>) {
    const body = await content;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
    });
    return body;
  }
}
