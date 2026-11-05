import { isSubscriptionEntitled, SubscriptionLike } from './subscription-state';

const now = new Date('2026-11-02T12:00:00Z');
const past = new Date('2026-11-01T00:00:00Z');
const future = new Date('2026-12-01T00:00:00Z');
const sub = (over: Partial<SubscriptionLike>): SubscriptionLike => ({
  status: 'ACTIVE',
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceUntil: null,
  ...over,
});

describe('isSubscriptionEntitled', () => {
  it('sans abonnement : forfait de repli', () => {
    expect(isSubscriptionEntitled(null, now)).toBe(false);
  });

  it('actif tant que la période court', () => {
    expect(isSubscriptionEntitled(sub({ currentPeriodEnd: future }), now)).toBe(
      true,
    );
    expect(isSubscriptionEntitled(sub({ currentPeriodEnd: past }), now)).toBe(
      false,
    );
  });

  it("essai valable jusqu'à sa date de fin", () => {
    expect(
      isSubscriptionEntitled(
        sub({ status: 'TRIALING', trialEndsAt: future }),
        now,
      ),
    ).toBe(true);
    expect(
      isSubscriptionEntitled(
        sub({ status: 'TRIALING', trialEndsAt: past }),
        now,
      ),
    ).toBe(false);
  });

  it('impayé : droits maintenus pendant la période de grâce', () => {
    expect(
      isSubscriptionEntitled(
        sub({ status: 'PAST_DUE', graceUntil: future }),
        now,
      ),
    ).toBe(true);
    expect(
      isSubscriptionEntitled(
        sub({ status: 'PAST_DUE', graceUntil: past }),
        now,
      ),
    ).toBe(false);
  });

  it('suspendu ou résilié : aucun droit', () => {
    expect(isSubscriptionEntitled(sub({ status: 'SUSPENDED' }), now)).toBe(
      false,
    );
    expect(isSubscriptionEntitled(sub({ status: 'CANCELLED' }), now)).toBe(
      false,
    );
  });
});
