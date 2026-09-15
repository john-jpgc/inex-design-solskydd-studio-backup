import { config } from '../config.ts';

/**
 * Utskicksvågor.
 *
 * Alla kunder får samma box varje månad. I början skickas den till alla samtidigt
 * ("single"). När volymen växer delas kunderna i fyra grupper efter vilken del av
 * månaden de gick med, och en grupp skickas per vecka ("weekly"). Vågen ändrar bara
 * *när* boxen går iväg – aldrig *vad* som ligger i den.
 */

export const WAVE_COUNT = 4;

export type Wave = 1 | 2 | 3 | 4;

export function waveCount(): number {
  return config.waves.mode === 'weekly' ? WAVE_COUNT : 1;
}

export function isWave(value: unknown): value is Wave {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= WAVE_COUNT;
}

export function waveLabel(wave: number): string {
  if (config.waves.mode === 'single') return 'Alla samtidigt';
  return `Våg ${wave} (dag ${dayOfMonthFor(wave)})`;
}

export function dayOfMonthFor(wave: number): number {
  return config.waves.daysOfMonth[Math.min(Math.max(wave, 1), WAVE_COUNT) - 1] ?? 1;
}

/**
 * Vilken våg en kund hamnar i utifrån när hen gick med. Dag 1–7 ger våg 1,
 * 8–14 våg 2 och så vidare. I "single"-läge hamnar alla i våg 1.
 */
export function waveForJoinDate(joinedAt: string | Date): Wave {
  if (config.waves.mode === 'single') return 1;
  const day = (typeof joinedAt === 'string' ? new Date(joinedAt) : joinedAt).getUTCDate();
  const days = config.waves.daysOfMonth;
  let wave = 1;
  for (let i = 0; i < days.length; i++) {
    if (day >= (days[i] ?? 1)) wave = i + 1;
  }
  return wave as Wave;
}

/** Första förnyelsedatumet för en våg, tidigast efter `after`. */
export function firstRenewalFor(wave: number, after: string | Date = new Date()): string {
  const from = typeof after === 'string' ? new Date(after) : after;
  const day = dayOfMonthFor(wave);
  let candidate = atDay(from.getUTCFullYear(), from.getUTCMonth(), day);
  if (candidate <= from.toISOString()) {
    candidate = atDay(from.getUTCFullYear(), from.getUTCMonth() + 1, day);
  }
  return candidate;
}

/** Nästa förnyelse efter en genomförd, med vågens dag i månaden. */
export function nextRenewalFor(wave: number, current: string, intervalMonths = 1): string {
  const d = new Date(current);
  return atDay(d.getUTCFullYear(), d.getUTCMonth() + intervalMonths, dayOfMonthFor(wave));
}

function atDay(year: number, monthIndex: number, day: number): string {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay), config.waves.hourUtc, 0, 0)).toISOString();
}
