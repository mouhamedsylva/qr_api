import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WebhookEndpoint } from '@prisma/client';
import { paginate, PaginationQueryDto } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { RealtimeMessage } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import type {
  CreateWebhookDto,
  UpdateWebhookDto,
} from './dto/integrations.dto';
import {
  generateWebhookSecret,
  nextAttemptDelay,
  rejectWebhookUrl,
  signWebhook,
} from './integrations.rules';

/** Durée de réservation d'un envoi en cours (évite les doublons multi-instances). */
const LEASE_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Désactivation automatique après autant d'envois abandonnés d'affilée. */
const MAX_CONSECUTIVE_FAILURES = 20;
const BATCH_SIZE = 50;

const ENDPOINT_FIELDS = {
  id: true,
  url: true,
  description: true,
  events: true,
  isActive: true,
  failureCount: true,
  disabledAt: true,
  createdAt: true,
} satisfies Prisma.WebhookEndpointSelect;

/**
 * Webhooks sortants (INT-02) : chaque événement métier est enregistré comme
 * envoi à faire (file persistante), signé, puis retenté avec un délai
 * croissant en cas d'échec.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly production: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    config: ConfigService,
  ) {
    this.production = config.get<string>('NODE_ENV') === 'production';
  }

  /** Les nouvelles tentatives sont lancées par la tâche planifiée « webhooks ». */
  onModuleInit() {
    this.realtime.subscribe((event) => this.enqueue(event));
  }

  // ───────────────────────── Points de réception ─────────────────────────

  list(restaurantId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { restaurantId, deletedAt: null },
      select: ENDPOINT_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Le secret de signature n'est communiqué qu'à la création (ou rotation). */
  async create(restaurantId: string, dto: CreateWebhookDto, actorId: string) {
    this.assertUrl(dto.url);
    const secret = generateWebhookSecret();
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: { ...dto, restaurantId, secret, createdById: actorId },
      select: ENDPOINT_FIELDS,
    });
    return { ...endpoint, secret };
  }

  async update(restaurantId: string, id: string, dto: UpdateWebhookDto) {
    await this.getEndpoint(restaurantId, id);
    if (dto.url) this.assertUrl(dto.url);
    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.isActive === true && { disabledAt: null, failureCount: 0 }),
      },
      select: ENDPOINT_FIELDS,
    });
  }

  async remove(restaurantId: string, id: string) {
    await this.getEndpoint(restaurantId, id);
    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async rotateSecret(restaurantId: string, id: string) {
    await this.getEndpoint(restaurantId, id);
    const secret = generateWebhookSecret();
    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { secret },
    });
    return { id, secret };
  }

  /** Envoi d'un événement « ping » pour tester l'intégration. */
  async sendTest(restaurantId: string, id: string) {
    const endpoint = await this.getEndpoint(restaurantId, id);
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventType: 'ping',
        nextAttemptAt: new Date(),
        payload: { message: 'Test de votre intégration QR-Order' },
      },
    });
    await this.deliver(delivery.id);
    return this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
  }

  async deliveries(
    restaurantId: string,
    endpointId: string,
    query: PaginationQueryDto,
  ) {
    await this.getEndpoint(restaurantId, endpointId);
    const where = { endpointId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  /** Renvoie un événement (nouvel envoi, l'historique est conservé). */
  async redeliver(restaurantId: string, deliveryId: string) {
    const original = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpoint: { restaurantId, deletedAt: null } },
    });
    if (!original) throw new NotFoundException('Envoi introuvable');
    const copy = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: original.endpointId,
        eventType: original.eventType,
        nextAttemptAt: new Date(),
        payload: original.payload as Prisma.InputJsonValue,
      },
    });
    await this.deliver(copy.id);
    return this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: copy.id },
    });
  }

  // ───────────────────────── File d'envoi ─────────────────────────

  /** Abonné aux événements métier : crée un envoi par destinataire concerné. */
  async enqueue(event: RealtimeMessage) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        restaurantId: event.restaurantId,
        isActive: true,
        deletedAt: null,
        disabledAt: null,
      },
      select: { id: true, events: true },
    });
    for (const endpoint of endpoints) {
      if (!(endpoint.events as string[]).includes(event.type)) continue;
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventType: event.type,
          nextAttemptAt: new Date(),
          payload: {
            seq: event.seq,
            orderId: event.orderId,
            data: event.payload,
          } as Prisma.InputJsonValue,
        },
      });
      // Envoi immédiat sans bloquer l'opération métier ; les échecs seront retentés.
      this.deliver(delivery.id).catch((err) => this.logger.error(err));
    }
  }

  /** Traite les envois dus (nouvelles tentatives, reprise après redémarrage). */
  async processDue() {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });
    for (const { id } of due) await this.deliver(id);
    return due.length;
  }

  /** Une tentative d'envoi, si l'envoi est dû et qu'aucune autre instance ne le traite. */
  async deliver(deliveryId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'PENDING', nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count === 0) return;

    const delivery = await this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    const { endpoint } = delivery;
    const body = JSON.stringify({
      id: delivery.id,
      type: delivery.eventType,
      createdAt: delivery.createdAt,
      restaurantId: endpoint.restaurantId,
      ...(delivery.payload as object),
    });

    let statusCode: number | null = null;
    let error: string | null = null;
    const refused = rejectWebhookUrl(endpoint.url, this.production);
    const stopped = !!endpoint.deletedAt || !endpoint.isActive;
    if (refused || stopped) {
      error = refused ?? 'Destinataire supprimé ou désactivé';
    } else {
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'QR-Order-Webhooks/1.0',
            'X-QROrder-Event': delivery.eventType,
            'X-QROrder-Delivery': delivery.id,
            'X-QROrder-Signature': signWebhook(endpoint.secret, body),
          },
          body,
          redirect: 'manual', // pas de redirection : protection SSRF
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        statusCode = res.status;
        if (res.status < 200 || res.status >= 300) {
          error = `Réponse HTTP ${res.status}`;
        }
      } catch (err) {
        error = (err as Error).message;
      }
    }

    const attempts = delivery.attempts + 1;
    if (!error) {
      await this.prisma.$transaction([
        this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'SUCCEEDED',
            attempts,
            lastStatusCode: statusCode,
            lastError: null,
            deliveredAt: new Date(),
          },
        }),
        this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { failureCount: 0 },
        }),
      ]);
      return;
    }

    // Destinataire supprimé ou désactivé : pas de nouvelle tentative.
    const delay = stopped ? null : nextAttemptDelay(attempts);
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts,
        lastStatusCode: statusCode,
        lastError: error.slice(0, 500),
        ...(delay === null
          ? { status: 'FAILED' }
          : { nextAttemptAt: new Date(Date.now() + delay) }),
      },
    });
    if (delay === null) await this.recordFailure(endpoint);
  }

  /** Envoi abandonné : au-delà d'un seuil, le destinataire est désactivé. */
  private async recordFailure(endpoint: WebhookEndpoint) {
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { failureCount: { increment: 1 } },
    });
    if (
      updated.failureCount >= MAX_CONSECUTIVE_FAILURES &&
      !updated.disabledAt
    ) {
      await this.prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { disabledAt: new Date(), isActive: false },
      });
      this.logger.warn(`Webhook ${endpoint.id} désactivé après échecs répétés`);
    }
  }

  private assertUrl(url: string) {
    const refused = rejectWebhookUrl(url, this.production);
    if (refused) {
      throw new BadRequestException({
        code: 'INVALID_WEBHOOK_URL',
        message: refused,
      });
    }
  }

  private async getEndpoint(restaurantId: string, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, restaurantId, deletedAt: null },
    });
    if (!endpoint) throw new NotFoundException('Webhook introuvable');
    return endpoint;
  }
}
