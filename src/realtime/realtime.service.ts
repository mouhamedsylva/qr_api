import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import {
  orderRoom,
  RealtimeEventType,
  RealtimeMessage,
  restaurantRoom,
} from './realtime.events';

export interface EmitInput {
  restaurantId: string;
  type: RealtimeEventType;
  /** Charge utile pour l'équipe (salle de l'établissement). */
  payload: unknown;
  orderId?: string;
  /** Charge utile réduite pour le client qui suit sa commande (salle de la commande). */
  customerPayload?: unknown;
}

const MAX_CATCH_UP = 500;

/**
 * Diffusion temps réel (NOT-01, NOT-02). Chaque événement est d'abord
 * enregistré avec un numéro de séquence : un client qui se reconnecte
 * rattrape les événements manqués (NOT-06), y compris en mode polling.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server?: Server;
  private readonly listeners: ((event: RealtimeMessage) => Promise<void>)[] =
    [];

  constructor(private readonly prisma: PrismaService) {}

  attachServer(server: Server) {
    this.server = server;
  }

  /**
   * Abonnement interne aux événements (ex. webhooks sortants) : chaque
   * événement persisté est transmis aux abonnés, sans bloquer l'émetteur.
   */
  subscribe(listener: (event: RealtimeMessage) => Promise<void>) {
    this.listeners.push(listener);
  }

  async emit(input: EmitInput): Promise<void> {
    try {
      const staffEvent = await this.prisma.realtimeEvent.create({
        data: {
          restaurantId: input.restaurantId,
          orderId: input.orderId,
          type: input.type,
          payload: toJson(input.payload),
        },
      });
      this.server
        ?.to(restaurantRoom(input.restaurantId))
        .emit(input.type, toMessage(staffEvent));

      if (input.orderId && input.customerPayload !== undefined) {
        // Les clients ne voient jamais la charge utile interne.
        this.server?.to(orderRoom(input.orderId)).emit(input.type, {
          ...toMessage(staffEvent),
          payload: input.customerPayload,
        });
      }
      for (const listener of this.listeners) {
        await listener(toMessage(staffEvent)).catch((err) =>
          this.logger.error(err),
        );
      }
    } catch (err) {
      // Une panne de diffusion ne doit jamais faire échouer l'opération métier.
      this.logger.error(err);
    }
  }

  /** Événements de l'établissement après `afterSeq` (rattrapage / polling). */
  async since(restaurantId: string, afterSeq: number, limit = MAX_CATCH_UP) {
    const events = await this.prisma.realtimeEvent.findMany({
      where: { restaurantId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: Math.min(limit, MAX_CATCH_UP),
    });
    return events.map(toMessage);
  }

  async lastSeq(restaurantId: string): Promise<number> {
    const last = await this.prisma.realtimeEvent.findFirst({
      where: { restaurantId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return last?.seq ?? 0;
  }
}

function toMessage(event: {
  seq: number;
  type: string;
  restaurantId: string;
  orderId: string | null;
  payload: Prisma.JsonValue;
  createdAt: Date;
}): RealtimeMessage {
  return {
    seq: event.seq,
    type: event.type as RealtimeMessage['type'],
    restaurantId: event.restaurantId,
    orderId: event.orderId,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}
