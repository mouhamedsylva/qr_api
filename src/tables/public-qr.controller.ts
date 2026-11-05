import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PublicMenuService } from '../menu/public-menu.service';
import { PrismaService } from '../prisma/prisma.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { QrTokenService } from './qr-token.service';

/**
 * Point d'entrée du parcours client : la PWA ouvre /t/<jeton> et appelle cette
 * route, qui renvoie en un seul appel l'établissement, la table et le menu.
 */
@ApiTags('Public')
@Public()
@Controller('public/qr')
export class PublicQrController {
  constructor(
    private readonly qr: QrTokenService,
    private readonly prisma: PrismaService,
    private readonly restaurants: RestaurantsService,
    private readonly menu: PublicMenuService,
  ) {}

  @Get(':token')
  async resolve(@Param('token') token: string) {
    const payload = this.qr.verify(token);
    const table =
      payload &&
      (await this.prisma.diningTable.findFirst({
        where: {
          id: payload.tableId,
          qrVersion: payload.version, // un QR régénéré invalide l'ancien
          deletedAt: null,
          restaurant: { deletedAt: null, status: 'ACTIVE' },
        },
        select: {
          id: true,
          label: true,
          kind: true,
          restaurant: { select: { slug: true } },
        },
      }));
    if (!table) {
      throw new NotFoundException({
        code: 'INVALID_QR',
        message: 'QR code invalide ou expiré',
      });
    }

    const restaurant = await this.restaurants.findPublicBySlug(
      table.restaurant.slug,
    );
    const menu = await this.menu.bySlug(table.restaurant.slug);
    return {
      restaurant,
      table: { id: table.id, label: table.label, kind: table.kind },
      menu,
    };
  }
}
