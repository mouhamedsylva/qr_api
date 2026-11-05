import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuditQueryDto } from '../admin/dto/admin.dto';

/** Consultation du journal d'audit (ADM-08, CON-04). */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.restaurantId && { restaurantId: query.restaurantId }),
      ...(query.actorId && { actorId: query.actorId }),
      ...(query.action && { action: { startsWith: query.action } }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };
    const [logs, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(logs, total, query);
  }
}
