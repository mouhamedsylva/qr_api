import { LifecycleInput, nextLifecycleStep } from './subscription-lifecycle';

const now = new Date('2026-11-05T12:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
const sub = (over: Partial<LifecycleInput>): LifecycleInput => ({
  status: 'TRIALING',
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceUntil: null,
  lastNotice: null,
  ...over,
});

describe('échéances d’abonnement (PAY-12)', () => {
  it('rappelle la fin de l’essai une seule fois, puis annonce sa fin', () => {
    expect(nextLifecycleStep(sub({ trialEndsAt: inDays(10) }), now)).toBeNull();
    expect(nextLifecycleStep(sub({ trialEndsAt: inDays(2) }), now)).toEqual({
      notice: 'TRIAL_ENDING',
    });
    expect(
      nextLifecycleStep(
        sub({ trialEndsAt: inDays(1), lastNotice: 'TRIAL_ENDING' }),
        now,
      ),
    ).toBeNull();
    expect(
      nextLifecycleStep(
        sub({ trialEndsAt: inDays(-1), lastNotice: 'TRIAL_ENDING' }),
        now,
      ),
    ).toEqual({ notice: 'TRIAL_ENDED' });
    expect(
      nextLifecycleStep(
        sub({ trialEndsAt: inDays(-1), lastNotice: 'TRIAL_ENDED' }),
        now,
      ),
    ).toBeNull();
  });

  it('passe en impayé avec période de grâce à l’échéance', () => {
    expect(
      nextLifecycleStep(
        sub({ status: 'ACTIVE', currentPeriodEnd: inDays(5) }),
        now,
      ),
    ).toBeNull();
    expect(
      nextLifecycleStep(
        sub({ status: 'ACTIVE', currentPeriodEnd: inDays(-1) }),
        now,
      ),
    ).toEqual({
      status: 'PAST_DUE',
      graceUntil: inDays(7),
      notice: 'PAYMENT_DUE',
    });
  });

  it('suspend à la fin de la période de grâce', () => {
    expect(
      nextLifecycleStep(
        sub({ status: 'PAST_DUE', graceUntil: inDays(2) }),
        now,
      ),
    ).toBeNull();
    expect(
      nextLifecycleStep(
        sub({ status: 'PAST_DUE', graceUntil: inDays(-1) }),
        now,
      ),
    ).toEqual({
      status: 'SUSPENDED',
      notice: 'SUSPENDED',
    });
    // Impayé sans date de grâce (saisi par l'administration) : grâce accordée.
    expect(nextLifecycleStep(sub({ status: 'PAST_DUE' }), now)).toMatchObject({
      graceUntil: inDays(7),
    });
  });

  it('ne touche pas aux abonnements suspendus ou résiliés', () => {
    expect(nextLifecycleStep(sub({ status: 'SUSPENDED' }), now)).toBeNull();
    expect(nextLifecycleStep(sub({ status: 'CANCELLED' }), now)).toBeNull();
  });
});
