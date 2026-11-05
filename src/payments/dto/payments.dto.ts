import { PaymentMethod } from '@prisma/client';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUrl,
  Length,
  Min,
} from 'class-validator';

export const MOBILE_MONEY_OPERATORS = [
  'WAVE',
  'ORANGE_MONEY',
  'FREE_MONEY',
] as const;

/** Encaissement espèces au comptoir (PAY-05, CMD-12). */
export class CashPaymentDto {
  /** Montant imputé ; par défaut le reste à payer. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  /** Somme remise par le client, pour calculer la monnaie à rendre. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountReceived?: number;
}

/** Paiement en ligne initié par le client (PAY-01, PAY-04, PAY-06). */
export class OnlinePaymentDto {
  @IsIn([PaymentMethod.CARD, PaymentMethod.MOBILE_MONEY])
  method: PaymentMethod;

  @IsOptional()
  @IsIn(MOBILE_MONEY_OPERATORS)
  operator?: string;

  @IsOptional()
  @IsPhoneNumber()
  payerPhone?: string;

  /** Paiement partiel (division de l'addition) ; par défaut le reste à payer. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;
}

/** Remboursement total ou partiel (PAY-07). */
export class RefundDto {
  /** Par défaut : le montant restant remboursable. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @IsString()
  @Length(3, 255)
  reason: string;
}

export class SandboxOutcomeDto {
  @IsIn(['SUCCEEDED', 'FAILED'])
  outcome: 'SUCCEEDED' | 'FAILED';

  /** Permet de simuler un montant reçu différent (anomalie). */
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;
}

export class StripeOnboardingDto {
  @IsUrl({ require_tld: false })
  returnUrl: string;

  @IsUrl({ require_tld: false })
  refreshUrl: string;
}
