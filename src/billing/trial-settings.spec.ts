import { trialSettingsError } from './platform-settings.service';
import { LifecycleInput, nextLifecycleStep } from './subscription-lifecycle';

const now = new Date('2026-11-10T12:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
const trial = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  status: 'TRIALING',
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceUntil: null,
  lastNotice: null,
  ...over,
});

describe('réglages de la période d’essai', () => {
  it('accepte des réglages cohérents', () => {
    expect(
      trialSettingsError({ trialDays: 14, trialReminderDays: 3 }),
    ).toBeNull();
    expect(
      trialSettingsError({ trialDays: 30, trialReminderDays: 0 }),
    ).toBeNull();
    // Pas d'essai : le rappel n'a pas d'importance.
    expect(
      trialSettingsError({ trialDays: 0, trialReminderDays: 3 }),
    ).toBeNull();
  });

  it('refuse un rappel qui ne précède pas la fin de l’essai', () => {
    expect(trialSettingsError({ trialDays: 7, trialReminderDays: 7 })).toMatch(
      /avant la fin/,
    );
    expect(trialSettingsError({ trialDays: 3, trialReminderDays: 10 })).toMatch(
      /avant la fin/,
    );
  });

  it('refuse des valeurs hors bornes', () => {
    expect(trialSettingsError({ trialDays: -1, trialReminderDays: 0 })).toMatch(
      /0 et 365/,
    );
    expect(
      trialSettingsError({ trialDays: 400, trialReminderDays: 3 }),
    ).toMatch(/0 et 365/);
    expect(
      trialSettingsError({ trialDays: 14, trialReminderDays: 31 }),
    ).toMatch(/0 et 30/);
    expect(
      trialSettingsError({ trialDays: 1.5, trialReminderDays: 0 }),
    ).toMatch(/0 et 365/);
  });
});

describe('rappel de fin d’essai paramétrable', () => {
  it('rappelle selon le délai réglé', () => {
    const sub = trial({ trialEndsAt: inDays(6) });
    expect(nextLifecycleStep(sub, now)).toBeNull(); // délai par défaut : 3 jours
    expect(nextLifecycleStep(sub, now, 7)).toEqual({ notice: 'TRIAL_ENDING' });
  });

  it('sans rappel (0 jour), annonce seulement la fin', () => {
    expect(
      nextLifecycleStep(trial({ trialEndsAt: inDays(1) }), now, 0),
    ).toBeNull();
    expect(
      nextLifecycleStep(trial({ trialEndsAt: inDays(-1) }), now, 0),
    ).toEqual({ notice: 'TRIAL_ENDED' });
  });
});
