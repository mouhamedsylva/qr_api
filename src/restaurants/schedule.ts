export interface OpeningSlot {
  dayOfWeek: number; // 0 = dimanche
  opensAt: string; // HH:mm
  closesAt: string; // HH:mm
}

export interface Closure {
  startsAt: Date;
  endsAt: Date;
}

export type OpenStatus =
  | { isOpen: true; reason: null }
  | { isOpen: false; reason: 'CLOSURE' | 'OUTSIDE_HOURS' };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Jour de semaine et minute de la journée dans le fuseau du restaurant. */
export function localTime(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    dayOfWeek: WEEKDAYS.indexOf(get('weekday') ?? ''),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Instant UTC correspondant à minuit (heure locale du restaurant) du jour de `now`. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsedMs =
    ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 +
    now.getMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}

/**
 * Détermine si l'établissement est ouvert (RES-06).
 * - Une fermeture exceptionnelle en cours l'emporte sur les horaires.
 * - Un créneau dont closesAt < opensAt déborde sur le lendemain (ex. 18:00–02:00).
 * - opensAt === closesAt signifie ouvert 24 h.
 */
export function computeOpenStatus(
  slots: OpeningSlot[],
  closures: Closure[],
  timeZone: string,
  now: Date = new Date(),
): OpenStatus {
  if (closures.some((c) => c.startsAt <= now && now < c.endsAt)) {
    return { isOpen: false, reason: 'CLOSURE' };
  }

  const { dayOfWeek, minutes } = localTime(now, timeZone);
  const previousDay = (dayOfWeek + 6) % 7;

  const open = slots.some((slot) => {
    const opens = toMinutes(slot.opensAt);
    const closes = toMinutes(slot.closesAt);
    if (slot.dayOfWeek === dayOfWeek) {
      if (opens === closes) return true;
      if (opens < closes) return minutes >= opens && minutes < closes;
      return minutes >= opens; // partie avant minuit
    }
    if (slot.dayOfWeek === previousDay && closes < opens) {
      return minutes < closes; // partie après minuit
    }
    return false;
  });

  return open
    ? { isOpen: true, reason: null }
    : { isOpen: false, reason: 'OUTSIDE_HOURS' };
}
