import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash } from '@node-rs/argon2';
import { Invitation, Membership, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  NOTIFICATION_SENDER,
  type NotificationSender,
} from '../auth/notifications/notification-sender';
import {
  PermissionOverrides,
  resolvePermissions,
} from '../auth/rbac/permissions';
import { TokenService } from '../auth/token.service';
import { BillingService } from '../billing/billing.service';
import type { RequestMeta } from '../common/decorators/request-meta.decorator';
import type { Actor, TenantContext } from '../common/types/request-context';
import { randomToken, sha256 } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { TERMS_VERSION } from '../privacy/terms';
import {
  AcceptInvitationDto,
  InviteMemberDto,
  UpdateMemberDto,
} from './dto/team.dto';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MEMBER_INCLUDE = {
  user: {
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      status: true,
    },
  },
} satisfies Prisma.MembershipInclude;

@Injectable()
export class TeamService {
  private readonly backofficeUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
    config: ConfigService,
  ) {
    this.backofficeUrl = (
      config.get<string>('BACKOFFICE_URL') ||
      config.getOrThrow<string>('CLIENT_APP_URL')
    ).replace(/\/+$/, '');
  }

  // ───────────────────────── Membres ─────────────────────────

  async listMembers(restaurantId: string) {
    const members = await this.prisma.membership.findMany({
      where: { restaurantId, deletedAt: null },
      include: MEMBER_INCLUDE,
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return members.map((m) => this.toMemberView(m));
  }

  /** Promotion / rétrogradation, profil et permissions (EQP-02, AUT-03). */
  async updateMember(
    restaurantId: string,
    membershipId: string,
    dto: UpdateMemberDto,
    tenant: TenantContext,
    actor: Actor,
  ) {
    const target = await this.getMember(restaurantId, membershipId);
    this.assertCanManage(target, tenant, actor, dto.role);

    const updated = await this.prisma.membership.update({
      where: { id: membershipId },
      data: {
        ...(dto.role && { role: dto.role }),
        ...(dto.staffProfile !== undefined && {
          staffProfile: dto.staffProfile,
        }),
        ...(dto.permissions && {
          permissions: {
            grant: dto.permissions.grant ?? [],
            deny: dto.permissions.deny ?? [],
          },
        }),
      },
      include: MEMBER_INCLUDE,
    });
    await this.audit.log({
      action: 'team.member_update',
      entity: 'Membership',
      entityId: membershipId,
      restaurantId,
      actorId: actor.id,
      before: {
        role: target.role,
        staffProfile: target.staffProfile,
        permissions: target.permissions,
      },
      after: {
        role: updated.role,
        staffProfile: updated.staffProfile,
        permissions: updated.permissions,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return this.toMemberView(updated);
  }

  /**
   * Révocation instantanée (EQP-03) : l'accès au restaurant est coupé dès la
   * requête suivante (les droits sont relus à chaque requête), et les sessions
   * sont fermées si la personne n'a plus aucun autre établissement.
   */
  async removeMember(
    restaurantId: string,
    membershipId: string,
    tenant: TenantContext,
    actor: Actor,
  ) {
    const target = await this.getMember(restaurantId, membershipId);
    this.assertCanManage(target, tenant, actor);

    await this.prisma.membership.update({
      where: { id: membershipId },
      data: { deletedAt: new Date() },
    });
    const remaining = await this.prisma.membership.count({
      where: { userId: target.userId, deletedAt: null },
    });
    if (remaining === 0) {
      await this.tokens.revokeAllForUser(target.userId);
    }
    await this.audit.log({
      action: 'team.member_remove',
      entity: 'Membership',
      entityId: membershipId,
      restaurantId,
      actorId: actor.id,
      before: { userId: target.userId, role: target.role },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  // ───────────────────────── Invitations (EQP-01) ─────────────────────────

  async invite(
    restaurantId: string,
    dto: InviteMemberDto,
    tenant: TenantContext,
    actor: Actor,
  ) {
    if (dto.role === 'MANAGER' && tenant.role === 'MANAGER') {
      throw roleHierarchy('Seul le propriétaire peut inviter un manager');
    }
    if (dto.email) {
      const member = await this.prisma.membership.findFirst({
        where: { restaurantId, deletedAt: null, user: { email: dto.email } },
      });
      if (member) {
        throw new ConflictException({
          code: 'ALREADY_MEMBER',
          message: 'Cette personne fait déjà partie de l’équipe',
        });
      }
    }
    await this.billing.assertRestaurantQuota(restaurantId, 'members');

    const token = randomToken(32);
    const invitation = await this.prisma.invitation.create({
      data: {
        restaurantId,
        email: dto.email,
        phone: dto.phone,
        role: dto.role,
        staffProfile: dto.staffProfile,
        permissions: dto.permissions
          ? {
              grant: dto.permissions.grant ?? [],
              deny: dto.permissions.deny ?? [],
            }
          : undefined,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById: actor.id,
      },
      include: { restaurant: { select: { name: true } } },
    });

    const inviteUrl = `${this.backofficeUrl}/invitation/${token}`;
    await this.sender
      .send({
        channel: dto.email ? 'EMAIL' : 'SMS',
        to: (dto.email ?? dto.phone)!,
        subject: `Invitation à rejoindre ${invitation.restaurant.name}`,
        body: `Vous êtes invité(e) à rejoindre l'équipe de ${invitation.restaurant.name} sur QR-Order : ${inviteUrl} (valable 7 jours)`,
      })
      .catch(() => undefined); // le lien reste partageable manuellement

    await this.audit.log({
      action: 'team.invite',
      entity: 'Invitation',
      entityId: invitation.id,
      restaurantId,
      actorId: actor.id,
      after: { email: dto.email, phone: dto.phone, role: dto.role },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    // Le lien est renvoyé pour un partage direct (WhatsApp…) ; il n'est jamais stocké en clair.
    return { ...this.toInvitationView(invitation), inviteUrl };
  }

  async listInvitations(restaurantId: string) {
    const invitations = await this.prisma.invitation.findMany({
      where: {
        restaurantId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map((i) => this.toInvitationView(i));
  }

  async revokeInvitation(restaurantId: string, invitationId: string) {
    const res = await this.prisma.invitation.updateMany({
      where: {
        id: invitationId,
        restaurantId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) {
      throw new NotFoundException('Invitation introuvable');
    }
  }

  /** Aperçu public d'une invitation (page d'acceptation). */
  async preview(token: string) {
    const invitation = await this.findValidInvitation(token);
    return {
      restaurant: { name: invitation.restaurant.name },
      role: invitation.role,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      accountExists: invitation.email
        ? (await this.prisma.user.count({
            where: { email: invitation.email },
          })) > 0
        : false,
    };
  }

  /** Acceptation par une personne sans compte : création du compte et de l'accès. */
  async acceptAsNewUser(
    token: string,
    dto: AcceptInvitationDto,
    meta: RequestMeta,
  ) {
    const invitation = await this.findValidInvitation(token);
    const email = invitation.email ?? dto.email;
    if (!email) {
      throw new BadRequestException({
        code: 'EMAIL_REQUIRED',
        message: 'Une adresse email est requise pour créer le compte',
      });
    }
    if (await this.prisma.user.count({ where: { email } })) {
      throw new ConflictException({
        code: 'ACCOUNT_EXISTS',
        message:
          'Un compte existe déjà avec cet email : connectez-vous pour accepter l’invitation',
      });
    }
    const passwordHash = await hash(dto.password);

    const user = await this.prisma.$transaction(async (tx) => {
      await this.consume(tx, invitation.id);
      const user = await tx.user.create({
        data: {
          email,
          phone: invitation.phone,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          // Le lien reçu par email prouve la possession de l'adresse.
          emailVerifiedAt: invitation.email ? new Date() : null,
          termsAcceptedAt: new Date(),
          termsVersion: TERMS_VERSION,
        },
      });
      await this.grantMembership(tx, invitation, user.id);
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedById: user.id },
      });
      return user;
    });

    return {
      restaurantId: invitation.restaurantId,
      tokens: await this.tokens.issue(user, meta),
    };
  }

  /** Acceptation par un utilisateur déjà connecté. */
  async acceptAsExistingUser(token: string, userId: string) {
    const invitation = await this.findValidInvitation(token);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (invitation.email && invitation.email !== user.email) {
      throw new ForbiddenException({
        code: 'INVITATION_EMAIL_MISMATCH',
        message: 'Cette invitation a été envoyée à une autre adresse email',
      });
    }
    const active = await this.prisma.membership.findFirst({
      where: { userId, restaurantId: invitation.restaurantId, deletedAt: null },
    });
    if (active) {
      throw new ConflictException({
        code: 'ALREADY_MEMBER',
        message: 'Vous faites déjà partie de cette équipe',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.consume(tx, invitation.id);
      await this.grantMembership(tx, invitation, userId);
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedById: userId },
      });
    });
    return { restaurantId: invitation.restaurantId };
  }

  // ───────────────────────── Interne ─────────────────────────

  private async findValidInvitation(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { restaurant: { select: { name: true, deletedAt: true } } },
    });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date() ||
      invitation.restaurant.deletedAt
    ) {
      throw new NotFoundException({
        code: 'INVITATION_INVALID',
        message: 'Invitation invalide, expirée ou déjà utilisée',
      });
    }
    return invitation;
  }

  /** Consommation atomique : une invitation ne sert qu'une fois. */
  private async consume(tx: Prisma.TransactionClient, invitationId: string) {
    const res = await tx.invitation.updateMany({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (res.count === 0) {
      throw new NotFoundException({
        code: 'INVITATION_INVALID',
        message: 'Invitation invalide, expirée ou déjà utilisée',
      });
    }
  }

  /** Crée l'accès, ou réactive un accès précédemment révoqué. */
  private grantMembership(
    tx: Prisma.TransactionClient,
    invitation: Invitation,
    userId: string,
  ) {
    const data = {
      role: invitation.role,
      staffProfile: invitation.staffProfile,
      permissions: invitation.permissions ?? Prisma.JsonNull,
      createdById: invitation.invitedById,
      deletedAt: null,
    };
    return tx.membership.upsert({
      where: {
        userId_restaurantId: { userId, restaurantId: invitation.restaurantId },
      },
      create: { ...data, userId, restaurantId: invitation.restaurantId },
      update: data,
    });
  }

  private async getMember(restaurantId: string, membershipId: string) {
    const member = await this.prisma.membership.findFirst({
      where: { id: membershipId, restaurantId, deletedAt: null },
    });
    if (!member) throw new NotFoundException('Membre introuvable');
    return member;
  }

  /**
   * Hiérarchie (EQP-02) : le propriétaire est intouchable, on ne se modifie
   * pas soi-même, et un manager ne gère que le staff (sans pouvoir promouvoir).
   */
  private assertCanManage(
    target: Membership,
    tenant: TenantContext,
    actor: Actor,
    newRole?: Role,
  ) {
    if (target.role === 'OWNER') {
      throw roleHierarchy('Le propriétaire ne peut pas être modifié ou retiré');
    }
    if (target.userId === actor.id) {
      throw roleHierarchy('Vous ne pouvez pas modifier votre propre accès');
    }
    if (
      tenant.role === 'MANAGER' &&
      (target.role === 'MANAGER' || newRole === 'MANAGER')
    ) {
      throw roleHierarchy('Seul le propriétaire peut gérer les managers');
    }
  }

  private toMemberView(
    m: Prisma.MembershipGetPayload<{ include: typeof MEMBER_INCLUDE }>,
  ) {
    return {
      id: m.id,
      role: m.role,
      staffProfile: m.staffProfile,
      permissionOverrides: m.permissions,
      permissions: [
        ...resolvePermissions(
          m.role,
          m.permissions as PermissionOverrides | null,
        ),
      ],
      user: m.user,
      createdAt: m.createdAt,
    };
  }

  private toInvitationView(i: Invitation) {
    return {
      id: i.id,
      email: i.email,
      phone: i.phone,
      role: i.role,
      staffProfile: i.staffProfile,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    };
  }
}

function roleHierarchy(message: string) {
  return new ForbiddenException({ code: 'ROLE_HIERARCHY', message });
}
