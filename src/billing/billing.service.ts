import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  BillingCycle,
  Plan,
  Prisma,
  Subscription,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_PLANS,
  FALLBACK_PLAN_CODE,
  Feature,
  TRIAL_PLAN_CODE,
} from './plans.defaults';
import { isSubscriptionEntitled } from './subscription-state';
import {
  nextLifecycleStep,
  SubscriptionNotice,
} from './subscription-lifecycle';
import {
  NOTIFICATION_SENDER,
  type NotificationSender,
} from '../auth/notifications/notification-sender';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/types/request-context';
import { PlatformSettingsService } from './platform-settings.service';

const DAY_MS = 86_400_000;

export type QuotaResource = 'restaurants' | 'tables' | 'members';

const LIMIT_FIELD: Record<QuotaResource, keyof Plan> = {
  restaurants: 'maxRestaurants',
  tables: 'maxTables',
  members: 'maxMembers',
};

export interface EffectivePlan {
  plan: Plan;
  subscription: Subscription | null;
  /** Vrai si l'abonnement n'ouvre plus de droits (forfait de repli appliqué). */
  isFallback: boolean;
}

/**
 * Forfaits et abonnements SaaS (PAY-03) et quotas par forfait (ADM-04).
 * L'abonnement appartient au propriétaire et couvre tous ses établissements.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private readonly subscriptionUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const backoffice =
      config.get<string>('BACKOFFICE_URL') ??
      config.get<string>('CLIENT_APP_URL') ??
      '';
    this.subscriptionUrl = `${backoffice.replace(/\/+$/, '')}/subscription`;
  }

  /** Crée les forfaits par défaut manquants (sans écraser les modifications). */
  async onModuleInit() {
    await this.prisma.plan.createMany({
      data: DEFAULT_PLANS.map((p) => ({ ...p, features: p.features })),
      skipDuplicates: true,
    });
  }

  listPublicPlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
    });
  }

  async planByCode(code: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Forfait introuvable',
      });
    }
    return plan;
  }

  /**
   * Essai gratuit démarré à l'inscription du propriétaire, d'une durée réglée
   * par l'administration (Vigie → Réglages). Durée 0 : pas d'essai, le
   * propriétaire démarre sur le forfait de repli (aucun abonnement créé).
   */
  async startTrial(tx: Prisma.TransactionClient, userId: string) {
    const { trialDays } = await this.settings.get();
    if (trialDays <= 0) return null;
    const plan = await tx.plan.findUniqueOrThrow({
      where: { code: TRIAL_PLAN_CODE },
    });
    return tx.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'TRIALING',
        trialEndsAt: new Date(Date.now() + trialDays * DAY_MS),
      },
    });
  }

  /** Offre d'essai affichée sur la page d'inscription. */
  async trialOffer() {
    const { trialDays } = await this.settings.get();
    if (trialDays <= 0) return { days: 0, plan: null };
    const plan = await this.planByCode(TRIAL_PLAN_CODE);
    return { days: trialDays, plan: { code: plan.code, name: plan.name } };
  }

  /** Le propriétaire a-t-il un abonnement valide (essai en cours, actif, ou impayé en période de grâce) ? */
  async isOwnerEntitled(ownerId: string, now = new Date()): Promise<boolean> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId: ownerId },
    });
    return isSubscriptionEntitled(sub, now);
  }

  /**
   * Restaurant ouvert au public (menu, QR codes, commandes) : son propriétaire
   * doit avoir un abonnement valide, sinon le restaurant est « momentanément
   * indisponible » pour ses clients.
   */
  async assertRestaurantInService(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ownerId: true },
    });
    if (!restaurant || !(await this.isOwnerEntitled(restaurant.ownerId))) {
      throw new ForbiddenException({
        code: 'RESTAURANT_UNAVAILABLE',
        message: 'Ce restaurant est momentanément indisponible',
      });
    }
  }

  /**
   * Souscription d'un forfait par le propriétaire (page Abonnement ou écran
   * d'abonnement) : le forfait est activé immédiatement pour un mois ou un an,
   * ce qui débloque le back-office et le menu client. La souscription est
   * signalée dans Vigie (« Souscriptions à vérifier ») pour contrôle du
   * règlement ; le paiement en ligne des abonnements n'est pas encore branché.
   */
  async chooseByOwner(
    userId: string,
    planCode: string,
    cycle: BillingCycle,
    actor: Actor,
  ) {
    const plan = await this.planByCode(planCode);
    if (!plan.isActive) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Forfait indisponible',
      });
    }
    await this.assertUsageFits(userId, plan);
    const now = new Date();
    const periodEnd = new Date(now);
    if (cycle === 'YEARLY') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);
    const data = {
      planId: plan.id,
      billingCycle: cycle,
      status: 'ACTIVE' as const,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      graceUntil: null,
      lastNotice: null,
      // Souscription à vérifier par l'équipe QR-Order (règlement).
      requestedPlanId: plan.id,
      requestedCycle: cycle,
      requestedAt: now,
    };
    const updated = await this.prisma.subscription.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
      include: { plan: true, requestedPlan: true },
    });
    await this.audit.log({
      action: 'billing.plan_subscribe',
      entity: 'Subscription',
      entityId: updated.id,
      actorId: actor.id,
      after: { plan: plan.code, cycle, until: periodEnd.toISOString() },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { applied: true, subscription: updated };
  }

  async effectivePlan(ownerId: string): Promise<EffectivePlan> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId: ownerId },
      include: { plan: true },
    });
    if (!subscription) {
      return {
        plan: await this.planByCode(FALLBACK_PLAN_CODE),
        subscription: null,
        isFallback: true,
      };
    }
    const { plan, ...sub } = subscription;
    if (isSubscriptionEntitled(sub)) {
      return { plan, subscription: sub, isFallback: false };
    }
    return {
      plan: await this.planByCode(FALLBACK_PLAN_CODE),
      subscription: sub,
      isFallback: true,
    };
  }

  async hasFeature(ownerId: string, feature: Feature): Promise<boolean> {
    const { plan } = await this.effectivePlan(ownerId);
    return (plan.features as string[]).includes(feature);
  }

  /** Utilisation actuelle du propriétaire (établissement le plus chargé pour tables / membres). */
  async usage(ownerId: string) {
    const restaurants = await this.prisma.restaurant.findMany({
      where: { ownerId, deletedAt: null },
      select: { id: true },
    });
    const ids = restaurants.map((r) => r.id);
    const perRestaurant = await Promise.all(
      ids.map(async (id) => ({
        tables: await this.countTables(id),
        members: await this.countMembers(id),
      })),
    );
    return {
      restaurants: ids.length,
      tables: Math.max(0, ...perRestaurant.map((u) => u.tables)),
      members: Math.max(0, ...perRestaurant.map((u) => u.members)),
    };
  }

  /** Vérifie qu'un ajout reste dans les quotas du forfait de l'établissement. */
  async assertRestaurantQuota(
    restaurantId: string,
    resource: Exclude<QuotaResource, 'restaurants'>,
    adding = 1,
  ) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { ownerId: true },
    });
    const current =
      resource === 'tables'
        ? await this.countTables(restaurantId)
        : await this.countMembers(restaurantId);
    await this.assertWithinLimit(restaurant.ownerId, resource, current, adding);
  }

  async assertOwnerQuota(ownerId: string, adding = 1) {
    const current = await this.prisma.restaurant.count({
      where: { ownerId, deletedAt: null },
    });
    await this.assertWithinLimit(ownerId, 'restaurants', current, adding);
  }

  /**
   * Changement de forfait par le propriétaire : libre pendant l'essai. Hors
   * essai, l'activation passe par l'administration tant que l'encaissement
   * automatique des abonnements n'est pas branché.
   */
  async changePlanAsOwner(
    userId: string,
    planCode: string,
    cycle: BillingCycle,
  ) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    const inTrial =
      subscription?.status === 'TRIALING' &&
      isSubscriptionEntitled(subscription);
    if (!subscription || !inTrial) {
      throw new ConflictException({
        code: 'PLAN_CHANGE_REQUIRES_BILLING',
        message:
          'Hors période d’essai, contactez le support pour changer de forfait',
      });
    }
    const plan = await this.planByCode(planCode);
    await this.assertUsageFits(userId, plan);
    return this.prisma.subscription.update({
      where: { userId },
      data: { planId: plan.id, billingCycle: cycle },
      include: { plan: true },
    });
  }

  /** Mise à jour par l'administration (activation, renouvellement, suspension). */
  async updateAsAdmin(
    userId: string,
    data: {
      planCode?: string;
      status?: SubscriptionStatus;
      billingCycle?: BillingCycle;
      currentPeriodEnd?: Date;
      graceUntil?: Date | null;
      force?: boolean;
    },
  ) {
    const plan = data.planCode ? await this.planByCode(data.planCode) : null;
    if (plan && !data.force) await this.assertUsageFits(userId, plan);
    const now = new Date();
    const existing = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    const fields = {
      ...(plan && { planId: plan.id }),
      ...(data.status && { status: data.status }),
      ...(data.billingCycle && { billingCycle: data.billingCycle }),
      ...(data.currentPeriodEnd && { currentPeriodEnd: data.currentPeriodEnd }),
      ...(data.graceUntil !== undefined && { graceUntil: data.graceUntil }),
      // Renouvellement ou réactivation : les relances d'échéance repartent à zéro.
      ...((data.status === 'ACTIVE' || data.currentPeriodEnd) && {
        lastNotice: null,
      }),
      ...(data.status === 'ACTIVE' &&
        existing?.status !== 'ACTIVE' && { currentPeriodStart: now }),
      ...((plan || data.status === 'ACTIVE') && {
        requestedPlanId: null,
        requestedCycle: null,
        requestedAt: null,
      }),
    };
    if (existing) {
      return this.prisma.subscription.update({
        where: { userId },
        data: fields,
        include: { plan: true },
      });
    }
    return this.prisma.subscription.create({
      data: {
        userId,
        planId: plan?.id ?? (await this.planByCode(FALLBACK_PLAN_CODE)).id,
        status: data.status ?? 'ACTIVE',
        billingCycle: data.billingCycle ?? 'MONTHLY',
        currentPeriodStart: now,
        currentPeriodEnd: data.currentPeriodEnd,
        graceUntil: data.graceUntil ?? null,
      },
      include: { plan: true },
    });
  }

  /** Vue « Mon abonnement » du propriétaire. */
  async overview(userId: string) {
    const effective = await this.effectivePlan(userId);
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true, requestedPlan: true },
    });
    const { trialReminderDays } = await this.settings.get();
    const endsAt =
      subscription?.status === 'TRIALING' ? subscription.trialEndsAt : null;
    return {
      subscription,
      effectivePlan: effective.plan,
      isFallback: effective.isFallback,
      usage: await this.usage(userId),
      trial: endsAt
        ? {
            endsAt,
            daysLeft: Math.max(
              0,
              Math.ceil((endsAt.getTime() - Date.now()) / DAY_MS),
            ),
            reminderDays: trialReminderDays,
          }
        : null,
      requestedPlan: subscription?.requestedPlan
        ? {
            code: subscription.requestedPlan.code,
            name: subscription.requestedPlan.name,
            cycle: subscription.requestedCycle,
            at: subscription.requestedAt,
          }
        : null,
    };
  }

  /**
   * Échéances des abonnements (PAY-12), exécutée par la tâche planifiée :
   * applique les changements de statut et envoie la relance correspondante
   * au propriétaire. Renvoie le nombre d'abonnements traités.
   */
  async runLifecycle(now = new Date()): Promise<number> {
    const candidates = await this.prisma.subscription.findMany({
      where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      include: {
        plan: { select: { name: true } },
        user: { select: { email: true, firstName: true, deletedAt: true } },
      },
    });
    const { trialReminderDays } = await this.settings.get();
    let processed = 0;
    for (const sub of candidates) {
      const step = nextLifecycleStep(sub, now, trialReminderDays);
      if (!step) continue;
      // Mise à jour conditionnelle : une autre instance n'enverra pas la même relance.
      const res = await this.prisma.subscription.updateMany({
        where: { id: sub.id, status: sub.status, lastNotice: sub.lastNotice },
        data: {
          ...(step.status && { status: step.status }),
          ...(step.graceUntil && { graceUntil: step.graceUntil }),
          lastNotice: step.notice,
        },
      });
      if (res.count === 0) continue;
      processed++;
      if (!sub.user.deletedAt) {
        await this.sender.send({
          channel: 'EMAIL',
          to: sub.user.email,
          template: `subscription_${step.notice.toLowerCase()}`,
          ...noticeMessage(
            step.notice,
            sub.user.firstName,
            sub.plan.name,
            {
              trialEndsAt: sub.trialEndsAt,
              graceUntil: step.graceUntil ?? sub.graceUntil,
            },
            this.subscriptionUrl,
          ),
        });
      }
    }
    return processed;
  }

  // ───────────────────────── Interne ─────────────────────────

  private async assertWithinLimit(
    ownerId: string,
    resource: QuotaResource,
    current: number,
    adding: number,
  ) {
    const { plan } = await this.effectivePlan(ownerId);
    const limit = plan[LIMIT_FIELD[resource]] as number | null;
    if (limit !== null && current + adding > limit) {
      throw new ForbiddenException({
        code: 'PLAN_LIMIT_REACHED',
        message: `Limite du forfait ${plan.name} atteinte (${resource} : ${limit})`,
        details: { resource, limit, current, plan: plan.code },
      });
    }
  }

  /** Refuse un passage à un forfait inférieur à l'utilisation actuelle. */
  private async assertUsageFits(userId: string, plan: Plan) {
    const usage = await this.usage(userId);
    const exceeded = (Object.keys(LIMIT_FIELD) as QuotaResource[]).filter(
      (r) => {
        const limit = plan[LIMIT_FIELD[r]] as number | null;
        return limit !== null && usage[r] > limit;
      },
    );
    if (exceeded.length) {
      throw new ConflictException({
        code: 'PLAN_LIMIT_EXCEEDED',
        message: `L'utilisation actuelle dépasse les limites du forfait ${plan.name}`,
        details: { exceeded, usage },
      });
    }
  }

  private countTables(restaurantId: string) {
    return this.prisma.diningTable.count({
      where: { restaurantId, deletedAt: null },
    });
  }

  /** Membres hors propriétaire + invitations en attente. */
  private async countMembers(restaurantId: string) {
    const [members, pending] = await Promise.all([
      this.prisma.membership.count({
        where: { restaurantId, deletedAt: null, role: { not: 'OWNER' } },
      }),
      this.prisma.invitation.count({
        where: {
          restaurantId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);
    return members + pending;
  }
}

const formatDate = (d: Date | null) =>
  d ? d.toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '';

/** Texte des relances d'abonnement envoyées au propriétaire. */
function noticeMessage(
  notice: SubscriptionNotice,
  firstName: string,
  planName: string,
  dates: { trialEndsAt: Date | null; graceUntil: Date | null },
  subscriptionUrl = '',
): { subject: string; body: string } {
  const link = subscriptionUrl
    ? `\n\nChoisir mon forfait : ${subscriptionUrl}`
    : '';
  const hello = `Bonjour ${firstName},\n\n`;
  const sign = '\n\nL’équipe QR-Order';
  switch (notice) {
    case 'TRIAL_ENDING':
      return {
        subject: 'Votre essai QR-Order se termine bientôt',
        body: `${hello}Votre essai du forfait ${planName} se termine le ${formatDate(dates.trialEndsAt)}. Choisissez votre forfait pour conserver toutes les fonctionnalités.${link}${sign}`,
      };
    case 'TRIAL_ENDED':
      return {
        subject: 'Votre essai QR-Order est terminé',
        body: `${hello}Votre essai du forfait ${planName} est terminé. Votre établissement continue de fonctionner avec le forfait Starter ; vos données sont conservées.${link}${sign}`,
      };
    case 'PAYMENT_DUE':
      return {
        subject: 'Paiement de votre abonnement QR-Order en attente',
        body: `${hello}Le renouvellement de votre forfait ${planName} n’a pas encore été réglé. Sans règlement avant le ${formatDate(dates.graceUntil)}, votre établissement passera au forfait Starter.${sign}`,
      };
    case 'SUSPENDED':
      return {
        subject: 'Votre abonnement QR-Order est suspendu',
        body: `${hello}Faute de règlement, votre forfait ${planName} est suspendu : votre établissement fonctionne désormais avec le forfait Starter. Contactez-nous pour le réactiver.${sign}`,
      };
  }
}
