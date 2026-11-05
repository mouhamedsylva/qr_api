import { Global, Module } from '@nestjs/common';
import { NOTIFICATION_SENDER } from '../auth/notifications/notification-sender';
import { CustomerNotificationsService } from './customer-notifications.service';
import { NotificationsService } from './notifications.service';
import { TransportRegistry } from './transports';

/** Global : tout module peut envoyer une notification via NOTIFICATION_SENDER. */
@Global()
@Module({
  providers: [
    TransportRegistry,
    NotificationsService,
    CustomerNotificationsService,
    { provide: NOTIFICATION_SENDER, useExisting: NotificationsService },
  ],
  exports: [NOTIFICATION_SENDER, NotificationsService],
})
export class NotificationsModule {}
