import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiHeader, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { Public } from '../common/decorators/public.decorator';
import { verifyOrderToken } from '../orders/order-token';
import { OnlinePaymentDto, SandboxOutcomeDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';
import { StripeWebhookService } from './stripe-webhook.service';

const ORDER_TOKEN_HEADER = { name: 'X-Order-Token', required: true };

/** Paiement par le client depuis son téléphone (PAY-06 : paiement en fin de repas). */
@ApiTags('Public')
@Public()
@Controller('public')
export class PublicPaymentsController {
  private readonly tokenSecret: string;
  private readonly sandboxEnabled: boolean;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.tokenSecret = config.getOrThrow<string>('QR_SIGNING_SECRET');
    this.sandboxEnabled =
      config.get<boolean>('PAYMENTS_SANDBOX_ENABLED') === true;
  }

  @Post('orders/:orderId/payments')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader(ORDER_TOKEN_HEADER)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  initiate(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: OnlinePaymentDto,
    @IdempotencyKey() key: string,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(orderId, token);
    return this.payments.initiateOnline(orderId, dto, key);
  }

  @Get('orders/:orderId/payments')
  @ApiHeader(ORDER_TOKEN_HEADER)
  summary(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(orderId, token);
    return this.payments.customerSummary(orderId);
  }

  @Get('orders/:orderId/receipt')
  @ApiHeader(ORDER_TOKEN_HEADER)
  receipt(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('x-order-token') token?: string,
  ) {
    this.assertToken(orderId, token);
    return this.payments.receipt(orderId);
  }

  /** Simulateur : confirmation de l'opérateur (désactivé hors dev / tests). */
  @Post('payments/:paymentId/sandbox')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  sandbox(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: SandboxOutcomeDto,
  ) {
    if (!this.sandboxEnabled) throw new NotFoundException();
    return this.payments.simulateSandbox(paymentId, dto.outcome, dto.amount);
  }

  private assertToken(orderId: string, token?: string) {
    if (!verifyOrderToken(this.tokenSecret, orderId, token)) {
      throw new NotFoundException('Commande introuvable');
    }
  }
}

/** Réception des webhooks des fournisseurs de paiement (PAY-08). */
@ApiTags('Webhooks')
@Public()
@SkipThrottle()
@Controller('webhooks')
export class PaymentWebhooksController {
  constructor(private readonly stripe: StripeWebhookService) {}

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.stripe.handle(req.rawBody, signature);
  }
}
