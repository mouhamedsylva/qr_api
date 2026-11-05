import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Un poste de préparation doit appartenir au même établissement (isolation multi-tenant). */
export async function assertStation(
  prisma: PrismaService,
  restaurantId: string,
  stationId: string | null | undefined,
) {
  if (!stationId) return;
  const exists = await prisma.station.count({
    where: { id: stationId, restaurantId, deletedAt: null },
  });
  if (!exists) {
    throw new BadRequestException({
      code: 'INVALID_STATION',
      message: 'Poste de préparation introuvable',
    });
  }
}
