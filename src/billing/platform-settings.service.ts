import { BadRequestException, Injectable } from '@nestjs/common';
import type { PlatformSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/types/request-context';
import { PrismaService } from '../prisma/prisma.service';

/** Valeurs de départ, identiques aux défauts du schéma. */
export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_TRIAL_REMINDER_DAYS = 3;

const CACHE_MS = 30_000;

export interface TrialSettingsInput {
  trialDays: number;
  trialReminderDays: number;
}

/** Cohérence des réglages d'essai ; renvoie un message d'erreur ou null. */
export function trialSettingsError({
  trialDays,
  trialReminderDays,
}: TrialSettingsInput): string | null {
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
    return 'La durée de l’essai doit être comprise entre 0 et 365 jours';
  }
  if (
    !Number.isInteger(trialReminderDays) ||
    trialReminderDays < 0 ||
    trialReminderDays > 30
  ) {
    return 'Le rappel doit être compris entre 0 et 30 jours avant la fin';
  }
  if (trialDays > 0 && trialReminderDays >= trialDays) {
    return 'Le rappel doit partir avant la fin de l’essai (moins de jours que sa durée)';
  }
  return null;
}

/**
 * Réglages de la plateforme modifiables par les super-admins (une seule
 * ligne). Lus à chaque inscription et à chaque passage de la tâche des
 * échéances, avec un cache court pour limiter les requêtes.
 */
@Injectable()
export class PlatformSettingsService {
  private cache: { value: PlatformSettings; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<PlatformSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.value;
    const value = await this.prisma.platformSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        trialDays: DEFAULT_TRIAL_DAYS,
        trialReminderDays: DEFAULT_TRIAL_REMINDER_DAYS,
      },
    });
    this.cache = { value, at: Date.now() };
    return value;
  }

  async updateTrial(
    input: TrialSettingsInput,
    actor: Actor,
  ): Promise<PlatformSettings> {
    const error = trialSettingsError(input);
    if (error)
      throw new BadRequestException({
        code: 'INVALID_TRIAL_SETTINGS',
        message: error,
      });
    const before = await this.get();
    const value = await this.prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        trialDays: input.trialDays,
        trialReminderDays: input.trialReminderDays,
        updatedById: actor.id,
      },
    });
    this.cache = { value, at: Date.now() };
    await this.audit.log({
      action: 'admin.trial_settings',
      entity: 'PlatformSettings',
      entityId: '1',
      actorId: actor.id,
      before: {
        trialDays: before.trialDays,
        trialReminderDays: before.trialReminderDays,
      },
      after: {
        trialDays: value.trialDays,
        trialReminderDays: value.trialReminderDays,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return value;
  }
}
