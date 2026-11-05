import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { createHmac, timingSafeEqual } from 'crypto';

export interface QrPayload {
  tableId: string;
  version: number;
}

/**
 * Jetons de QR code signés (TAB-02) : `<tableId>.<version>.<signature>`.
 * La signature HMAC empêche de forger le QR d'une autre table ; la version
 * permet de révoquer un QR compromis en le régénérant (TAB-07).
 */
@Injectable()
export class QrTokenService {
  private readonly secret: string;
  private readonly clientUrl: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('QR_SIGNING_SECRET');
    this.clientUrl = config
      .getOrThrow<string>('CLIENT_APP_URL')
      .replace(/\/+$/, '');
  }

  sign({ tableId, version }: QrPayload): string {
    return `${tableId}.${version}.${this.signature(tableId, version)}`;
  }

  verify(token: string): QrPayload | null {
    const [tableId, rawVersion, signature, ...rest] = token.split('.');
    if (rest.length || !tableId || !rawVersion || !signature) return null;
    if (!isUUID(tableId) || !/^\d{1,9}$/.test(rawVersion)) return null;

    const version = Number(rawVersion);
    const expected = Buffer.from(this.signature(tableId, version));
    const actual = Buffer.from(signature);
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return null;
    }
    return { tableId, version };
  }

  /** URL encodée dans le QR, ouverte par la PWA client. */
  url(payload: QrPayload): string {
    return `${this.clientUrl}/t/${this.sign(payload)}`;
  }

  private signature(tableId: string, version: number): string {
    return createHmac('sha256', this.secret)
      .update(`${tableId}.${version}`)
      .digest('base64url')
      .slice(0, 22); // 132 bits
  }
}
