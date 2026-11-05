import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CurrentActor } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { Actor } from '../common/types/request-context';
import { OrdersService } from '../orders/orders.service';
import {
  CashPaymentDto,
  RefundDto,
  StripeOnboardingDto,
} from './dto/payments.dto';
import { PaymentsService } from './payments.service';
import { StripeWebhookService } from './stripe-webhook.service';

@ApiTags('Paiements')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly orders: OrdersService,
    private readonly stripe: StripeWebhookService,
  ) {}

  @Get('orders/:orderId/payments')
  @RequirePermissions('orders.view')
  list(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.payments.listForOrder(restaurantId, orderId);
  }

  /** Encaissement espèces au comptoir ; renvoie la monnaie à rendre. */
  @Post('orders/:orderId/payments/cash')
  @RequirePermissions('payments.collect')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  cash(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CashPaymentDto,
    @IdempotencyKey() key: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.payments.recordCash(restaurantId, orderId, dto, key, actor);
  }

  @Get('orders/:orderId/receipt')
  @RequirePermissions('orders.view')
  async receipt(
    @Param('restaurantId') restaurantId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    await this.orders.findOne(restaurantId, orderId); // contrôle du tenant
    return this.payments.receipt(orderId);
  }

  /** Rapprochement manuel d'un paiement resté en attente (webhook manqué). */
  @Post('payments/:paymentId/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.collect')
  reconcile(
    @Param('restaurantId') restaurantId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.payments.reconcile(restaurantId, paymentId);
  }

  @Post('payments/:paymentId/refunds')
  @RequirePermissions('orders.refund')
  refund(
    @Param('restaurantId') restaurantId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: RefundDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.payments.refund(restaurantId, paymentId, dto, actor);
  }

  // ───────────── Stripe Connect (PAY-02) ─────────────

  @Get('payments/stripe/status')
  @RequirePermissions('billing.manage')
  stripeStatus(@Param('restaurantId') restaurantId: string) {
    return this.stripe.connectStatus(restaurantId);
  }

  @Post('payments/stripe/onboarding')
  @RequirePermissions('billing.manage')
  stripeOnboarding(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: StripeOnboardingDto,
  ) {
    return this.stripe.onboardingLink(
      restaurantId,
      dto.returnUrl,
      dto.refreshUrl,
    );
  }
}
