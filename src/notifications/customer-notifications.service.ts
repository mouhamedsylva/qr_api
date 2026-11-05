import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  NOTIFICATION_SENDER,
  type NotificationSender,
} from '../auth/notifications/notification-sender';
import { PrismaService } from '../prisma/prisma.service';
import {
  RealtimeEvents,
  type RealtimeMessage,
} from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';

/** Montant lisible, ex. « 3 500 XOF ». */
export function formatAmount(amount: number, currency: string): string {
  return `${new Intl.NumberFormat('fr-FR').format(amount).replace(/\s/g, ' ')} ${currency}`;
}

/**
 * Notifications au client (NOT-02, NOT-04), déclenchées par les événements
 * métier : commande prête (SMS au numéro laissé, email au compte) et reçu
 * par email au règlement complet.
 */
@Injectable()
export class CustomerNotificationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
  ) {}

  onModuleInit() {
    this.realtime.subscribe((event) => this.handle(event));
  }

  async handle(event: RealtimeMessage) {
    if (!event.orderId) return;
    const payload = event.payload as {
      status?: string;
      paymentStatus?: string;
    };
    if (
      event.type === RealtimeEvents.OrderStatusChanged &&
      payload.status === 'READY'
    ) {
      await this.orderReady(event.orderId);
    }
    if (
      event.type === RealtimeEvents.OrderPaymentUpdated &&
      payload.paymentStatus === 'PAID'
    ) {
      await this.receipt(event.orderId);
    }
  }

  private loadOrder(orderId: string) {
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        number: true,
        mode: true,
        total: true,
        currency: true,
        receiptNumber: true,
        customerPhone: true,
        customer: { select: { email: true, firstName: true, deletedAt: true } },
        restaurant: { select: { name: true } },
        table: { select: { label: true } },
      },
    });
  }

  private async orderReady(orderId: string) {
    const order = await this.loadOrder(orderId);
    const where =
      order.mode === 'TAKEAWAY'
        ? 'à retirer au comptoir'
        : `servie bientôt${order.table ? ` (table ${order.table.label})` : ''}`;
    const body = `${order.restaurant.name} : votre commande n°${order.number} est prête, ${where}.`;
    if (order.customerPhone) {
      await this.sender.send({
        channel: 'SMS',
        to: order.customerPhone,
        body,
        template: 'order_ready',
      });
    }
    if (order.customer && !order.customer.deletedAt) {
      await this.sender.send({
        channel: 'EMAIL',
        to: order.customer.email,
        subject: `Votre commande n°${order.number} est prête`,
        body: `Bonjour ${order.customer.firstName},\n\n${body}\n\nBon appétit !`,
        template: 'order_ready',
      });
    }
  }

  private async receipt(orderId: string) {
    const order = await this.loadOrder(orderId);
    if (!order.customer || order.customer.deletedAt) return;
    const receipt = order.receiptNumber
      ? `R-${String(order.receiptNumber).padStart(6, '0')}`
      : '';
    await this.sender.send({
      channel: 'EMAIL',
      to: order.customer.email,
      subject: `Votre reçu ${receipt} — ${order.restaurant.name}`,
      body:
        `Bonjour ${order.customer.firstName},\n\n` +
        `Merci pour votre commande n°${order.number} chez ${order.restaurant.name}.\n` +
        `Montant réglé : ${formatAmount(order.total, order.currency)}\n` +
        `Reçu : ${receipt}\n\n` +
        `Le détail est disponible dans l'historique de vos commandes.`,
      template: 'receipt',
    });
  }
}
