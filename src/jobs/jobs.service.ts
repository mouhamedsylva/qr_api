import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BillingService } from '../billing/billing.service';
import { WebhooksService } from '../integrations/webhooks.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { JobLockService } from './job-lock.service';
import { MaintenanceService } from './maintenance.service';

interface JobDefinition {
  name: string;
  everyMs: number;
  description: string;
  run: () => Promise<unknown>;
}

const MINUTE = 60_000;

/**
 * Tâches planifiées. Chacune ne s'exécute que sur une instance à la fois
 * (verrou à bail en base) ; elles sont désactivables par JOBS_ENABLED.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobsService.name);
  private readonly enabled: boolean;
  readonly jobs: JobDefinition[];

  constructor(
    config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly locks: JobLockService,
    private readonly prisma: PrismaService,
    notifications: NotificationsService,
    webhooks: WebhooksService,
    payments: PaymentsService,
    billing: BillingService,
    maintenance: MaintenanceService,
  ) {
    this.enabled = config.get<boolean>('JOBS_ENABLED') === true;
    this.jobs = [
      {
        name: 'notifications',
        everyMs: 30_000,
        description: 'Nouvelles tentatives des notifications en attente',
        run: () => notifications.processDue(),
      },
      {
        name: 'webhooks',
        everyMs: 30_000,
        description: 'Nouvelles tentatives des webhooks en attente',
        run: () => webhooks.processDue(),
      },
      {
        name: 'payments-reconcile',
        everyMs: 5 * MINUTE,
        description: 'Rapprochement des paiements en ligne en attente (PAY-08)',
        run: () => payments.reconcileStale(),
      },
      {
        name: 'subscriptions',
        everyMs: 60 * MINUTE,
        description: 'Échéances et relances des abonnements (PAY-12)',
        run: () => billing.runLifecycle(),
      },
      {
        name: 'maintenance',
        everyMs: 6 * 60 * MINUTE,
        description: 'Purge des données techniques expirées',
        run: () => maintenance.purge(),
      },
    ];
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log('Tâches planifiées désactivées (JOBS_ENABLED=false)');
      return;
    }
    for (const job of this.jobs) {
      const timer = setInterval(() => {
        this.run(job.name).catch((err) =>
          this.logger.error(`Tâche ${job.name} en échec : ${String(err)}`),
        );
      }, job.everyMs);
      this.scheduler.addInterval(job.name, timer);
    }
  }

  /** Exécution d'une tâche (planifiée ou déclenchée par l'administration). */
  async run(name: string) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new NotFoundException('Tâche inconnue');
    // Bail confortable : couvre une exécution longue sans bloquer indéfiniment.
    const lease = Math.max(job.everyMs * 2, 2 * MINUTE);
    const outcome = await this.locks.runExclusive(job.name, lease, job.run);
    return outcome
      ? { job: name, ran: true, result: outcome.result }
      : {
          job: name,
          ran: false,
          reason: 'Déjà en cours sur une autre instance',
        };
  }

  /** État des tâches et des files (ADM-09, santé du système). */
  async status() {
    const [
      locks,
      pendingNotifications,
      failedNotifications,
      pendingWebhooks,
      pendingPayments,
    ] = await Promise.all([
      this.locks.status(),
      this.prisma.notificationOutbox.count({ where: { status: 'PENDING' } }),
      this.prisma.notificationOutbox.count({ where: { status: 'FAILED' } }),
      this.prisma.webhookDelivery.count({ where: { status: 'PENDING' } }),
      this.prisma.payment.count({
        where: { status: 'PENDING', provider: { not: 'CASH' } },
      }),
    ]);
    const byName = new Map(locks.map((l) => [l.name, l]));
    return {
      enabled: this.enabled,
      jobs: this.jobs.map((j) => ({
        name: j.name,
        description: j.description,
        everySeconds: j.everyMs / 1000,
        lastRunAt: byName.get(j.name)?.lastRunAt ?? null,
        lastError: byName.get(j.name)?.lastError ?? null,
        running: (byName.get(j.name)?.lockedUntil ?? new Date(0)) > new Date(),
      })),
      queues: {
        notificationsPending: pendingNotifications,
        notificationsFailed: failedNotifications,
        webhooksPending: pendingWebhooks,
        onlinePaymentsPending: pendingPayments,
      },
    };
  }
}
