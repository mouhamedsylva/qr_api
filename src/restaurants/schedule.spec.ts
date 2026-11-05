import {
  computeOpenStatus,
  localTime,
  OpeningSlot,
  startOfLocalDay,
} from './schedule';

// 2026-11-02 est un lundi (dayOfWeek = 1).
const at = (iso: string) => new Date(iso);

describe('localTime', () => {
  it('applique le fuseau horaire', () => {
    expect(localTime(at('2026-11-02T10:30:00Z'), 'Africa/Dakar')).toEqual({
      dayOfWeek: 1,
      minutes: 630,
    });
    // Paris est à UTC+1 en novembre
    expect(localTime(at('2026-11-02T23:30:00Z'), 'Europe/Paris')).toEqual({
      dayOfWeek: 2,
      minutes: 30,
    });
  });
});

describe('startOfLocalDay', () => {
  it('renvoie minuit local en UTC', () => {
    expect(
      startOfLocalDay(at('2026-11-02T15:42:10.500Z'), 'Africa/Dakar'),
    ).toEqual(at('2026-11-02T00:00:00Z'));
    // 00:30 à Paris (UTC+1) le 3 novembre → minuit local = 23:00 UTC la veille
    expect(startOfLocalDay(at('2026-11-02T23:30:00Z'), 'Europe/Paris')).toEqual(
      at('2026-11-02T23:00:00Z'),
    );
  });
});

describe('computeOpenStatus', () => {
  const lunch: OpeningSlot[] = [
    { dayOfWeek: 1, opensAt: '12:00', closesAt: '15:00' },
  ];

  it('ouvert pendant le créneau', () => {
    expect(
      computeOpenStatus(lunch, [], 'Africa/Dakar', at('2026-11-02T12:00:00Z'))
        .isOpen,
    ).toBe(true);
  });

  it("fermé à l'heure exacte de fermeture et hors créneau", () => {
    expect(
      computeOpenStatus(lunch, [], 'Africa/Dakar', at('2026-11-02T15:00:00Z')),
    ).toEqual({ isOpen: false, reason: 'OUTSIDE_HOURS' });
    expect(
      computeOpenStatus(lunch, [], 'Africa/Dakar', at('2026-11-03T13:00:00Z'))
        .isOpen,
    ).toBe(false);
  });

  it('gère le passage de minuit', () => {
    const night: OpeningSlot[] = [
      { dayOfWeek: 1, opensAt: '18:00', closesAt: '02:00' },
    ];
    // lundi 23:00
    expect(
      computeOpenStatus(night, [], 'Africa/Dakar', at('2026-11-02T23:00:00Z'))
        .isOpen,
    ).toBe(true);
    // mardi 01:30 — rattaché au créneau du lundi
    expect(
      computeOpenStatus(night, [], 'Africa/Dakar', at('2026-11-03T01:30:00Z'))
        .isOpen,
    ).toBe(true);
    // mardi 02:00
    expect(
      computeOpenStatus(night, [], 'Africa/Dakar', at('2026-11-03T02:00:00Z'))
        .isOpen,
    ).toBe(false);
  });

  it('opensAt === closesAt signifie ouvert 24 h', () => {
    const allDay: OpeningSlot[] = [
      { dayOfWeek: 1, opensAt: '00:00', closesAt: '00:00' },
    ];
    expect(
      computeOpenStatus(allDay, [], 'Africa/Dakar', at('2026-11-02T03:00:00Z'))
        .isOpen,
    ).toBe(true);
  });

  it('une fermeture exceptionnelle prime sur les horaires', () => {
    const closures = [
      {
        startsAt: at('2026-11-02T00:00:00Z'),
        endsAt: at('2026-11-03T00:00:00Z'),
      },
    ];
    expect(
      computeOpenStatus(
        lunch,
        closures,
        'Africa/Dakar',
        at('2026-11-02T13:00:00Z'),
      ),
    ).toEqual({ isOpen: false, reason: 'CLOSURE' });
  });
});
