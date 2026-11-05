import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel } from '@prisma/client';
import { createTransport, Transporter } from 'nodemailer';

export interface Delivery {
  to: string;
  subject?: string | null;
  body: string;
}

/** Un canal d'envoi (SMTP, fournisseur SMS, API WhatsApp Business…). */
export interface Transport {
  readonly name: string;
  send(delivery: Delivery): Promise<void>;
}

/** Emails via SMTP (NOT-04). */
export class SmtpTransport implements Transport {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transporter = createTransport(url);
  }

  async send(delivery: Delivery) {
    await this.transporter.sendMail({
      from: this.from,
      to: delivery.to,
      subject: delivery.subject ?? 'QR-Order',
      text: delivery.body,
    });
  }
}

/**
 * Canal de repli : écrit le message dans les logs. Utilisé pour les SMS et
 * WhatsApp tant qu'aucun fournisseur n'est branché, et pour les emails sans SMTP.
 */
export class LogTransport implements Transport {
  readonly name = 'log';
  private readonly logger = new Logger('Notifications');

  constructor(private readonly channel: NotificationChannel) {}

  send(delivery: Delivery) {
    this.logger.log(
      `[${this.channel}] → ${delivery.to} | ${delivery.subject ?? ''} ${delivery.body}`,
    );
    return Promise.resolve();
  }
}

/** Choix du canal d'envoi selon la configuration. */
@Injectable()
export class TransportRegistry {
  private readonly transports: Record<NotificationChannel, Transport>;

  constructor(config: ConfigService) {
    const smtpUrl = config.get<string>('SMTP_URL');
    this.transports = {
      EMAIL: smtpUrl
        ? new SmtpTransport(smtpUrl, config.getOrThrow<string>('SMTP_FROM'))
        : new LogTransport('EMAIL'),
      // Fournisseurs à brancher (Orange SMS API, agrégateur, WhatsApp Business…).
      SMS: new LogTransport('SMS'),
      WHATSAPP: new LogTransport('WHATSAPP'),
    };
  }

  for(channel: NotificationChannel): Transport {
    return this.transports[channel];
  }
}
