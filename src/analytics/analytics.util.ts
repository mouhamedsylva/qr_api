import { localTime } from '../restaurants/schedule';

const DAY_MS = 86_400_000;

/** Date locale « AAAA-MM-JJ » dans le fuseau de l'établissement. */
export function localDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Heure locale 0–23. */
export function localHour(date: Date, timeZone: string): number {
  return Math.floor(localTime(date, timeZone).minutes / 60);
}

/** Tous les jours locaux couverts par la période, pour des séries sans trou. */
export function localDaysBetween(
  from: Date,
  to: Date,
  timeZone: string,
): string[] {
  const days: string[] = [];
  const last = localDateKey(to, timeZone);
  // Pas de 12 h : robuste aux changements d'heure, les doublons sont filtrés.
  for (let t = from.getTime(); ; t += DAY_MS / 2) {
    const key = localDateKey(new Date(Math.min(t, to.getTime())), timeZone);
    if (days[days.length - 1] !== key) days.push(key);
    if (key === last || t >= to.getTime()) break;
  }
  return days;
}

/** Période précédente de même durée, pour la comparaison (ANA-01). */
export function previousPeriod(from: Date, to: Date) {
  const length = to.getTime() - from.getTime();
  return {
    from: new Date(from.getTime() - length),
    to: new Date(from.getTime()),
  };
}

/** Variation en %, arrondie au dixième ; null si la référence est nulle. */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
