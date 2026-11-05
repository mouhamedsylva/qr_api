import {
  localDateKey,
  localDaysBetween,
  localHour,
  percentChange,
  previousPeriod,
} from './analytics.util';

describe('outils analytics', () => {
  it('calcule le jour et l’heure locaux', () => {
    const d = new Date('2026-11-02T23:30:00Z');
    expect(localDateKey(d, 'Africa/Dakar')).toBe('2026-11-02');
    expect(localDateKey(d, 'Europe/Paris')).toBe('2026-11-03');
    expect(localHour(d, 'Africa/Dakar')).toBe(23);
    expect(localHour(d, 'Europe/Paris')).toBe(0);
  });

  it('liste chaque jour local de la période, y compris au changement d’heure', () => {
    expect(
      localDaysBetween(
        new Date('2026-11-01T10:00:00Z'),
        new Date('2026-11-03T08:00:00Z'),
        'Africa/Dakar',
      ),
    ).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    // Passage à l'heure d'hiver en France le 25/10/2026
    const days = localDaysBetween(
      new Date('2026-10-24T12:00:00Z'),
      new Date('2026-10-27T12:00:00Z'),
      'Europe/Paris',
    );
    expect(days).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
  });

  it('définit la période précédente de même durée', () => {
    const p = previousPeriod(
      new Date('2026-11-10T00:00:00Z'),
      new Date('2026-11-20T00:00:00Z'),
    );
    expect(p).toEqual({
      from: new Date('2026-10-31T00:00:00Z'),
      to: new Date('2026-11-10T00:00:00Z'),
    });
  });

  it('calcule une variation en pourcentage', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(90, 120)).toBe(-25);
    expect(percentChange(5, 0)).toBeNull();
  });
});
