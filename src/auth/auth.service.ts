import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { OtpChannel, User } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { TERMS_VERSION } from '../privacy/terms';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/decorators/request-meta.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import {
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** Étapes du parcours d'onboarding restaurateur (cahier des charges §5). */
const ONBOARDING_STEPS = [
  'account',
  'restaurant',
  'menu',
  'tables',
  'qr_codes',
  'plan',
  'test_order',
] as const;

@Injectable()
export class AuthService {
  // Haché factice : vérifié quand l'email est inconnu, pour un temps de réponse constant.
  private readonly dummyHash = hash('timing-attack-mitigation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly restaurants: RestaurantsService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  /** AUT-01 : création du compte OWNER et de son établissement en une transaction. */
  async register(dto: RegisterDto, meta: RequestMeta) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
      },
      select: { email: true },
    });
    if (existing) {
      throw new ConflictException({
        code: existing.email === dto.email ? 'EMAIL_TAKEN' : 'PHONE_TAKEN',
        message:
          existing.email === dto.email
            ? 'Un compte existe déjà avec cet email'
            : 'Un compte existe déjà avec ce numéro',
      });
    }

    const passwordHash = await hash(dto.password);
    const { user, restaurant } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          termsAcceptedAt: new Date(),
          termsVersion: TERMS_VERSION,
        },
      });
      await this.billing.startTrial(tx, user.id);
      const restaurant = await this.restaurants.createForOwner(tx, user.id, {
        name: dto.restaurantName,
        city: dto.city,
        country: dto.country,
        phone: dto.phone,
        email: dto.email,
      });
      await this.audit.log(
        {
          action: 'auth.register',
          entity: 'User',
          entityId: user.id,
          restaurantId: restaurant.id,
          actorId: user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return { user, restaurant };
    });

    await this.otp
      .send(user, 'VERIFY_EMAIL', 'EMAIL', user.email)
      .catch(() => undefined); // l'échec d'envoi ne bloque pas l'inscription

    const tokens = await this.tokens.issue(user, meta);
    return {
      user: toPublicUser(user),
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
      },
      onboarding: {
        completed: ['account', 'restaurant'],
        steps: ONBOARDING_STEPS,
      },
      tokens,
    };
  }

  /** AUT-04 / AUT-09 : connexion avec verrouillage après échecs répétés. */
  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    if (!user) {
      await verify(await this.dummyHash, dto.password).catch(() => false);
      throw invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        {
          code: 'ACCOUNT_LOCKED',
          message:
            'Compte temporairement verrouillé suite à plusieurs tentatives échouées',
          details: { lockedUntil: user.lockedUntil },
        },
        HttpStatus.LOCKED,
      );
    }

    const valid = await verify(user.passwordHash, dto.password).catch(
      () => false,
    );
    if (!valid) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      });
      if (lock) {
        await this.audit.log({
          action: 'auth.account_locked',
          entity: 'User',
          entityId: user.id,
          actorId: user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
      throw invalidCredentials();
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Ce compte est suspendu',
      });
    }

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    const tokens = await this.tokens.issue(user, meta);
    return { user: toPublicUser(user), tokens };
  }

  refresh(refreshToken: string, meta: RequestMeta) {
    return this.tokens.rotate(refreshToken, meta);
  }

  logout(refreshToken: string) {
    return this.tokens.revoke(refreshToken);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return {
      ...toPublicUser(user),
      restaurants: await this.restaurants.listForUser(userId),
    };
  }

  /** AUT-05 : envoi d'un code de vérification email ou téléphone. */
  async sendVerification(userId: string, dto: SendOtpDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const to = dto.channel === OtpChannel.EMAIL ? user.email : user.phone;
    if (!to) {
      throw new BadRequestException({
        code: 'PHONE_MISSING',
        message: 'Aucun numéro de téléphone associé au compte',
      });
    }
    const purpose =
      dto.channel === OtpChannel.EMAIL ? 'VERIFY_EMAIL' : 'VERIFY_PHONE';
    await this.otp.send(user, purpose, dto.channel, to);
    return { sent: true };
  }

  async confirmVerification(userId: string, dto: VerifyOtpDto) {
    const isEmail = dto.channel === OtpChannel.EMAIL;
    await this.otp.verify(
      userId,
      isEmail ? 'VERIFY_EMAIL' : 'VERIFY_PHONE',
      dto.code,
    );
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: isEmail
        ? { emailVerifiedAt: new Date() }
        : { phoneVerifiedAt: new Date() },
    });
    return toPublicUser(user);
  }

  /** Réponse identique que l'email existe ou non (pas d'énumération de comptes). */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null, status: 'ACTIVE' },
    });
    if (user) {
      await this.otp
        .send(user, 'RESET_PASSWORD', 'EMAIL', user.email)
        .catch(() => undefined);
    }
    return {
      message: 'Si un compte existe pour cet email, un code a été envoyé',
    };
  }

  async resetPassword(dto: ResetPasswordDto, meta: RequestMeta) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });
    if (!user) {
      throw new BadRequestException({
        code: 'INVALID_OTP',
        message: 'Code invalide ou expiré',
      });
    }
    await this.otp.verify(user.id, 'RESET_PASSWORD', dto.code);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hash(dto.newPassword),
        failedLoginCount: 0,
        lockedUntil: null,
        // Le code reçu par email prouve la possession de l'adresse.
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });
    await this.tokens.revokeAllForUser(user.id);
    await this.audit.log({
      action: 'auth.password_reset',
      entity: 'User',
      entityId: user.id,
      actorId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { message: 'Mot de passe réinitialisé, veuillez vous reconnecter' };
  }
}

function invalidCredentials() {
  return new UnauthorizedException({
    code: 'INVALID_CREDENTIALS',
    message: 'Email ou mot de passe incorrect',
  });
}

export function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
    isSuperAdmin: user.isSuperAdmin,
    emailVerified: !!user.emailVerifiedAt,
    phoneVerified: !!user.phoneVerifiedAt,
    createdAt: user.createdAt,
  };
}
