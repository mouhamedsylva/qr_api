import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditQueryDto } from '../admin/dto/admin.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AuditQueryService } from './audit-query.service';

/** Journal d'activité d'un établissement (EQP-07, CON-04). */
@ApiTags('Audit')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @RequirePermissions('audit.view')
  list(
    @Param('restaurantId') restaurantId: string,
    @Query() query: AuditQueryDto,
  ) {
    // Le filtre restaurant est imposé : impossible de lire le journal d'un autre établissement.
    return this.audit.search(Object.assign(query, { restaurantId }));
  }
}
