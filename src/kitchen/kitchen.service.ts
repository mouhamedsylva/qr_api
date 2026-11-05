import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KitchenItemStatus, Prisma } from '@prisma/client';
import {
  lockOrder,
  ORDER_INCLUDE,
  OrdersService,
} from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvents } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CreateStationDto,
  TicketsQueryDto,
  UNASSIGNED,
  UpdateStationDto,
} from './dto/kitchen.dto';
import {
  canMoveItem,
  compareTickets,
  computeUrgency,
  deriveOrderStatus,
  KITCHEN_ORDER_STATUSES,
} from './kitchen.rules';

const STATION_SELECT = {
  id: true,
  name: true,
  color: true,
} satisfies Prisma.StationSelect;

/**
 * Écran cuisine (module 11, côté API) : tickets en temps réel par poste,
 * avancement ligne par ligne, et passage automatique de la commande en
 * préparation puis « prête ».
 */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly realtime: RealtimeService,
  ) {}

  // ───────────────────────── Postes (KDS-02) ─────────────────────────

  listStations(restaurantId: string) {
    return this.prisma.station.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: {
          select: {
            categories: { where: { deletedAt: null } },
            menuItems: { where: { deletedAt: null } },
          },
        },
      },
    });
  }

  async createStation(restaurantId: string, dto: CreateStationDto) {
    const last = await this.prisma.station.aggregate({
      where: { restaurantId, deletedAt: null },
      _max: { position: true },
    });
    return this.prisma.station.create({
      data: {
        ...dto,
        restaurantId,
        position: dto.position ?? (last._max.position ?? -1) + 1,
      },
    });
  }

  async updateStation(restaurantId: string, id: string, dto: UpdateStationDto) {
    await this.getStation(restaurantId, id);
    return this.prisma.station.update({ where: { id }, data: dto });
  }

  /** Les catégories et articles routés vers ce poste redeviennent non routés. */
  async removeStation(restaurantId: string, id: string) {
    await this.getStation(restaurantId, id);
    await this.prisma.$transaction([
      this.prisma.category.updateMany({
        where: { restaurantId, stationId: id },
        data: { stationId: null },
      }),
      this.prisma.menuItem.updateMany({
        where: { restaurantId, stationId: id },
        data: { stationId: null },
      }),
      this.prisma.station.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      }),
    ]);
  }

  // ───────────────────────── Tickets (KDS-01) ─────────────────────────

  /**
   * Tickets à préparer, filtrés par poste : commandes acceptées ou en
   * préparation, avec niveau d'urgence et tri par priorité.
   */
  async tickets(restaurantId: string, query: TicketsQueryDto) {
    const stationFilter =
      query.stationId === undefined
        ? {}
        : {
            stationId: query.stationId === UNASSIGNED ? null : query.stationId,
          };
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId,
        status: { in: KITCHEN_ORDER_STATUSES },
        items: { some: stationFilter },
      },
      include: {
        table: { select: { label: true } },
        items: {
          where: stationFilter,
          orderBy: [{ batch: 'asc' }, { position: 'asc' }],
          include: { station: { select: STATION_SELECT } },
        },
      },
    });

    const now = new Date();
    const tickets = orders
      .map((o) => ({
        orderId: o.id,
        number: o.number,
        mode: o.mode,
        table: o.table?.label ?? null,
        status: o.status,
        isRush: o.isRush,
        notes: o.notes,
        customerName: o.customerName,
        createdAt: o.createdAt,
        acceptedAt: o.acceptedAt,
        estimatedReadyAt: o.estimatedReadyAt,
        ageMinutes: Math.floor(
          (now.getTime() - o.createdAt.getTime()) / 60_000,
        ),
        urgency: computeUrgency(o.createdAt, o.estimatedReadyAt, now),
        items: o.items.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          options: (i.options as { name: string }[]).map((opt) => opt.name),
          notes: i.notes,
          batch: i.batch,
          kitchenStatus: i.kitchenStatus,
          station: i.station,
        })),
      }))
      .filter(
        (t) =>
          query.includeReady ||
          t.items.some((i) => i.kitchenStatus !== 'READY'),
      );
    return tickets.sort(compareTickets);
  }

  // ───────────────────────── Avancement ─────────────────────────

  /** Avancement d'une ligne (en préparation, prête, ou correction). */
  async updateItem(
    restaurantId: string,
    orderItemId: string,
    status: KitchenItemStatus,
  ) {
    const item = await this.prisma.orderItem.findFirst({
      where: { id: orderItemId, order: { restaurantId } },
      select: { orderId: true },
    });
    if (!item) throw new NotFoundException('Ligne introuvable');
    return this.move(restaurantId, item.orderId, { id: orderItemId }, status);
  }

  /** « Bump » d'un ticket : toutes les lignes du poste (ou de la commande). */
  bump(
    restaurantId: string,
    orderId: string,
    stationId: string | undefined,
    status: KitchenItemStatus,
  ) {
    const filter: Prisma.OrderItemWhereInput =
      stationId === undefined
        ? {}
        : { stationId: stationId === UNASSIGNED ? null : stationId };
    return this.move(restaurantId, orderId, filter, status, true);
  }

  async setRush(restaurantId: string, orderId: string, isRush: boolean) {
    const res = await this.prisma.order.updateMany({
      where: { id: orderId, restaurantId },
      data: { isRush },
    });
    if (res.count === 0) throw new NotFoundException('Commande introuvable');
    await this.realtime.emit({
      restaurantId,
      orderId,
      type: RealtimeEvents.KitchenItemUpdated,
      payload: { orderId, isRush },
    });
    return { orderId, isRush };
  }

  /**
   * Applique un nouvel état aux lignes ciblées, sous verrou de la commande,
   * puis fait suivre le statut de la commande (préparation → prête).
   */
  private async move(
    restaurantId: string,
    orderId: string,
    filter: Prisma.OrderItemWhereInput,
    status: KitchenItemStatus,
    skipUnchanged = false,
  ) {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, restaurantId, orderId);
      if (!KITCHEN_ORDER_STATUSES.includes(order.status)) {
        throw new ConflictException({
          code: 'ORDER_NOT_IN_KITCHEN',
          message:
            order.status === 'PENDING'
              ? 'La commande doit d’abord être acceptée'
              : 'Cette commande n’est plus en cuisine',
          details: { status: order.status },
        });
      }
      const targets = await tx.orderItem.findMany({
        where: { ...filter, orderId },
      });
      if (targets.length === 0) {
        throw new NotFoundException('Aucune ligne pour ce poste');
      }
      const toMove = targets.filter((i) =>
        skipUnchanged ? i.kitchenStatus !== status : true,
      );
      for (const item of toMove) {
        if (!canMoveItem(item.kitchenStatus, status)) {
          throw new ConflictException({
            code: 'INVALID_TRANSITION',
            message: `Transition impossible : ${item.kitchenStatus} → ${status}`,
            details: { itemId: item.id, from: item.kitchenStatus, to: status },
          });
        }
      }
      if (toMove.length) {
        await tx.orderItem.updateMany({
          where: { id: { in: toMove.map((i) => i.id) } },
          data: {
            kitchenStatus: status,
            ...(status === 'READY' && { readyAt: now }),
            ...(status === 'IN_PROGRESS' && { readyAt: null }),
          },
        });
        // Heure de début conservée lors d'une correction (READY → IN_PROGRESS).
        await tx.orderItem.updateMany({
          where: { id: { in: toMove.map((i) => i.id) }, startedAt: null },
          data: { startedAt: now },
        });
      }

      const all = await tx.orderItem.findMany({
        where: { orderId },
        select: { kitchenStatus: true },
      });
      const next = deriveOrderStatus(
        order.status,
        all.map((i) => i.kitchenStatus),
      );
      const updated = next
        ? await tx.order.update({
            where: { id: orderId },
            data: { status: next, ...(next === 'READY' && { readyAt: now }) },
            include: ORDER_INCLUDE,
          })
        : await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            include: ORDER_INCLUDE,
          });
      return { order: updated, previous: order.status, moved: toMove };
    });

    await this.realtime.emit({
      restaurantId,
      orderId,
      type: RealtimeEvents.KitchenItemUpdated,
      payload: {
        orderId,
        number: result.order.number,
        items: result.moved.map((i) => ({
          id: i.id,
          stationId: i.stationId,
          kitchenStatus: status,
        })),
      },
    });
    if (result.order.status !== result.previous) {
      // NOT-02 : le client est notifié quand sa commande est prête.
      await this.realtime.emit({
        restaurantId,
        orderId,
        type: RealtimeEvents.OrderStatusChanged,
        payload: { ...result.order, previousStatus: result.previous },
        customerPayload: this.orders.toCustomerView(result.order),
      });
    }
    return {
      orderId,
      status: result.order.status,
      items: result.order.items.map((i) => ({
        id: i.id,
        name: i.name,
        stationId: i.stationId,
        kitchenStatus: i.kitchenStatus,
      })),
    };
  }

  private async getStation(restaurantId: string, id: string) {
    const station = await this.prisma.station.findFirst({
      where: { id, restaurantId, deletedAt: null },
    });
    if (!station) throw new NotFoundException('Poste introuvable');
    return station;
  }
}
