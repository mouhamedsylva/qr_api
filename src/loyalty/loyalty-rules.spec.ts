import { isExpired, pointsForAmount } from './loyalty-rules';

describe('règles de fidélité', () => {
  const program = { pointsPerUnit: 1, unitAmount: 100 };

  it('attribue des points par tranche complète', () => {
    expect(pointsForAmount(7550, program)).toBe(75);
    expect(pointsForAmount(99, program)).toBe(0);
    expect(pointsForAmount(1000, { pointsPerUnit: 5, unitAmount: 1000 })).toBe(
      5,
    );
    expect(pointsForAmount(-10, program)).toBe(0);
  });

  it("expire après la période d'inactivité", () => {
    const now = new Date('2026-11-02T00:00:00Z');
    expect(isExpired(new Date('2026-10-01T00:00:00Z'), 30, now)).toBe(true);
    expect(isExpired(new Date('2026-10-10T00:00:00Z'), 30, now)).toBe(false);
    expect(isExpired(new Date('2020-01-01T00:00:00Z'), null, now)).toBe(false);
  });
});
