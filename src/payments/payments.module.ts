import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OrdersModule } from '../orders/orders.module';
import { SandboxGateway } from './gateways/sandbox.gateway';
import { STRIPE_CLIENT, StripeGateway } from './gateways/stripe.gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  PaymentWebhooksController,
  PublicPaymentsController,
} from './public-payments.controller';
import { StripeWebhookService } from './stripe-webhook.service';

@Module({
  imports: [OrdersModule, LoyaltyModule],
  controllers: [
    PaymentsController,
    PublicPaymentsController,
    PaymentWebhooksController,
  ],
  providers: [
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('STRIPE_SECRET_KEY');
        return key ? new Stripe(key, { maxNetworkRetries: 2 }) : null;
      },
    },
    StripeGateway,
    SandboxGateway,
    PaymentsService,
    StripeWebhookService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
