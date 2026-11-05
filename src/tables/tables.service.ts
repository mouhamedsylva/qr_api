import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as QRCode from 'qrcode';
import { BillingService } from '../billing/billing.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvents } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import {
  BulkCreateTablesDto,
  CreateTableDto,
  CreateZoneDto,
  ListTablesQueryDto,
  UpdateTableDto,
  UpdateTableStatusDto,
  UpdateZoneDto,
} from './dto/tables.dto';
import { QrTokenService } from './qr-token.service';

export const MAX_BULK_TABLES = 200;

const TABLE_INCLUDE = {
  zone: { select: { id: true, name: true } },
} satisfies Prisma.DiningTableInclude;

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrTokenService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly billing: BillingService,
  ) {}

  // ───────────── Zones (TAB-04) ─────────────

  listZones(restaurantId: string) {
    return this.prisma.zone.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { tables: { where: { deletedAt: null } } } },
      },
    });
  }

  async createZone(restaurantId: string, dto: CreateZoneDto) {
    const last = await this.prisma.zone.aggregate({
      where: { restaurantId, deletedAt: null },
      _max: { position: true },
    });
    return this.prisma.zone.create({
      data: {
        ...dto,
        restaurantId,
        position: (last._max.position ?? -1) + 1,
      },
    });
  }

  async updateZone(restaurantId: string, id: string, dto: UpdateZoneDto) {
    await this.assertZone(restaurantId, id);
    return this.prisma.zone.update({ where: { id }, data: dto });
  }

  /** Les tables de la zone supprimée sont conservées, sans zone. */
  async removeZone(restaurantId: string, id: string) {
    await this.assertZone(restaurantId, id);
    await this.prisma.$transaction([
      this.prisma.diningTable.updateMany({
        where: { zoneId: id, restaurantId },
        data: { zoneId: null },
      }),
      this.prisma.zone.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    ]);
  }

  // ───────────── Tables (TAB-01, TAB-03) ─────────────

  list(restaurantId: string, query: ListTablesQueryDto) {
    return this.prisma.diningTable.findMany({
      where: {
        restaurantId,
        deletedAt: null,
        ...(query.zoneId && { zoneId: query.zoneId }),
        ...(query.status && { status: query.status }),
      },
      include: TABLE_INCLUDE,
      orderBy: [{ position: 'asc' }, { label: 'asc' }],
    });
  }

  async findOne(restaurantId: string, id: string) {
    const table = await this.prisma.diningTable.findFirst({
      where: { id, restaurantId, deletedAt: null },
      include: TABLE_INCLUDE,
    });
    if (!table) {
      throw new NotFoundException('Table introuvable');
    }
    return table;
  }

  async create(restaurantId: string, dto: CreateTableDto, actorId: string) {
    await this.billing.assertRestaurantQuota(restaurantId, 'tables');
    if (dto.zoneId) await this.assertZone(restaurantId, dto.zoneId);
    await this.assertLabelsFree(restaurantId, [dto.label]);
    return this.prisma.diningTable.create({
      data: {
        ...dto,
        restaurantId,
        position: await this.nextPosition(restaurantId),
        createdById: actorId,
      },
      include: TABLE_INCLUDE,
    });
  }

  async bulkCreate(
    restaurantId: string,
    dto: BulkCreateTablesDto,
    actorId: string,
  ) {
    if (dto.to < dto.from) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: '`to` doit être supérieur ou égal à `from`',
      });
    }
    const count = dto.to - dto.from + 1;
    if (count > MAX_BULK_TABLES) {
      throw new BadRequestException({
        code: 'TOO_MANY_TABLES',
        message: `${MAX_BULK_TABLES} tables maximum par lot`,
      });
    }
    if (dto.zoneId) await this.assertZone(restaurantId, dto.zoneId);

    const labels = Array.from(
      { length: count },
      (_, i) => `${dto.prefix}${dto.from + i}`,
    );
    await this.assertLabelsFree(restaurantId, labels);
    await this.billing.assertRestaurantQuota(restaurantId, 'tables', count);

    const start = await this.nextPosition(restaurantId);
    await this.prisma.diningTable.createMany({
      data: labels.map((label, i) => ({
        restaurantId,
        label,
        zoneId: dto.zoneId,
        capacity: dto.capacity,
        position: start + i,
        createdById: actorId,
      })),
    });
    return this.prisma.diningTable.findMany({
      where: { restaurantId, label: { in: labels }, deletedAt: null },
      include: TABLE_INCLUDE,
      orderBy: { position: 'asc' },
    });
  }

  async update(restaurantId: string, id: string, dto: UpdateTableDto) {
    const table = await this.findOne(restaurantId, id);
    if (dto.zoneId) await this.assertZone(restaurantId, dto.zoneId);
    if (dto.label && dto.label !== table.label) {
      await this.assertLabelsFree(restaurantId, [dto.label]);
    }
    return this.prisma.diningTable.update({
      where: { id },
      data: dto,
      include: TABLE_INCLUDE,
    });
  }

  /** Statut en temps réel (TAB-03), diffusé à l'équipe (`table.updated`). */
  async updateStatus(
    restaurantId: string,
    id: string,
    dto: UpdateTableStatusDto,
  ) {
    await this.findOne(restaurantId, id);
    const table = await this.prisma.diningTable.update({
      where: { id },
      data: { status: dto.status, statusChangedAt: new Date() },
      include: TABLE_INCLUDE,
    });
    await this.realtime.emit({
      restaurantId,
      type: RealtimeEvents.TableUpdated,
      payload: {
        id: table.id,
        label: table.label,
        status: table.status,
        statusChangedAt: table.statusChangedAt,
      },
    });
    return table;
  }

  async remove(restaurantId: string, id: string) {
    await this.findOne(restaurantId, id);
    await this.prisma.diningTable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async reorder(restaurantId: string, ids: string[]) {
    const count = await this.prisma.diningTable.count({
      where: { id: { in: ids }, restaurantId, deletedAt: null },
    });
    if (count !== ids.length) {
      throw new BadRequestException({
        code: 'INVALID_IDS',
        message: 'Certaines tables sont introuvables',
      });
    }
    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.diningTable.update({ where: { id }, data: { position } }),
      ),
    );
  }

  // ───────────── QR codes (TAB-02, TAB-07) ─────────────

  async qrInfo(restaurantId: string, id: string) {
    const table = await this.findOne(restaurantId, id);
    const payload = { tableId: table.id, version: table.qrVersion };
    return {
      tableId: table.id,
      label: table.label,
      version: table.qrVersion,
      url: this.qr.url(payload),
    };
  }

  async qrImage(
    restaurantId: string,
    id: string,
    format: 'png' | 'svg',
    size: number,
  ): Promise<Buffer> {
    const { url } = await this.qrInfo(restaurantId, id);
    const options = {
      errorCorrectionLevel: 'M' as const,
      margin: 2,
      width: size,
    };
    if (format === 'svg') {
      return Buffer.from(
        await QRCode.toString(url, { ...options, type: 'svg' }),
      );
    }
    return QRCode.toBuffer(url, { ...options, type: 'png' });
  }

  /** Invalide l'ancien QR (compromis, volé…) sans perdre l'historique de la table. */
  async regenerateQr(restaurantId: string, id: string, actor: Actor) {
    const table = await this.findOne(restaurantId, id);
    const updated = await this.prisma.diningTable.update({
      where: { id },
      data: { qrVersion: { increment: 1 } },
    });
    await this.audit.log({
      action: 'tables.qr_regenerate',
      entity: 'DiningTable',
      entityId: id,
      restaurantId,
      actorId: actor.id,
      before: { qrVersion: table.qrVersion },
      after: { qrVersion: updated.qrVersion },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return this.qrInfo(restaurantId, id);
  }

  // ───────────── Utilitaires ─────────────

  private async assertZone(restaurantId: string, zoneId: string) {
    const exists = await this.prisma.zone.count({
      where: { id: zoneId, restaurantId, deletedAt: null },
    });
    if (!exists) {
      throw new NotFoundException({
        code: 'ZONE_NOT_FOUND',
        message: 'Zone introuvable',
      });
    }
  }

  /** Libellé unique parmi les tables actives (permet de réutiliser celui d'une table supprimée). */
  private async assertLabelsFree(restaurantId: string, labels: string[]) {
    const taken = await this.prisma.diningTable.findMany({
      where: { restaurantId, deletedAt: null, label: { in: labels } },
      select: { label: true },
    });
    if (taken.length) {
      throw new ConflictException({
        code: 'TABLE_LABEL_TAKEN',
        message: 'Ces libellés de table existent déjà',
        details: { labels: taken.map((t) => t.label) },
      });
    }
  }

  private async nextPosition(restaurantId: string) {
    const last = await this.prisma.diningTable.aggregate({
      where: { restaurantId, deletedAt: null },
      _max: { position: true },
    });
    return (last._max.position ?? -1) + 1;
  }
}
