import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpChannel, OtpPurpose } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomNumericCode } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_SENDER,
  type NotificationSender,
} from './notifications/notification-sender';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

const SUBJECTS: Record<OtpPurpose, string> = {
  VERIFY_EMAIL: 'Vérification de votre adresse email',
  VERIFY_PHONE: 'Vérification de votre numéro',
  RESET_PASSWORD: 'Réinitialisation de votre mot de passe',
};

/** Codes à usage unique (AUT-05) : 6 chiffres, hachés, 10 min, 5 essais. */
@Injectable()
export class OtpService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  private hash(userId: string, code: string): string {
    return createHmac('sha256', this.secret)
      .update(`${userId}:${code}`)
      .digest('hex');
  }

  async send(
    user: { id: string },
    purpose: OtpPurpose,
    channel: OtpChannel,
    to: string,
  ): Promise<void> {
    const last = await this.prisma.otpCode.findFirst({
      where: { userId: user.id, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (
      last &&
      Date.now() - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      throw new HttpException(
        {
          code: 'OTP_COOLDOWN',
          message: 'Veuillez patienter avant de demander un nouveau code',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomNumericCode(6);
    await this.prisma.$transaction([
      // Un seul code actif par usage.
      this.prisma.otpCode.updateMany({
        where: { userId: user.id, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.otpCode.create({
        data: {
          userId: user.id,
          purpose,
          channel,
          codeHash: this.hash(user.id, code),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        },
      }),
    ]);

    await this.sender.send({
      channel,
      to,
      subject: SUBJECTS[purpose],
      body: `Votre code QR-Order : ${code} (valable 10 minutes)`,
    });
  }

  /** Vérifie et consomme le code ; lève une 400 sinon. */
  async verify(userId: string, purpose: OtpPurpose, code: string) {
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        userId,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw invalidCode();
    }

    const expected = Buffer.from(otp.codeHash, 'hex');
    const actual = Buffer.from(this.hash(userId, code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalidCode();
    }

    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw invalidCode();
    }
  }
}

function invalidCode() {
  return new BadRequestException({
    code: 'INVALID_OTP',
    message: 'Code invalide ou expiré',
  });
}
