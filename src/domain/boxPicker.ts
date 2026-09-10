import type { Strength } from './products.ts';
import { strengthDistance } from './products.ts';

/**
 * Sammansättning av en mystery-box.
 *
 * Väljer produkter från tillgängligt lager utifrån kundens preferenser, undviker
 * uteslutna smaker, straffar produkter kunden redan fått och eftersträvar variation
 * i smak och märke inom boxen. Slumpmässigheten är seedad så att samma indata ger
 * samma förslag (bra för felsökning), men olika seed ger olika "mystery".
 */

export interface PickCandidate {
  id: number;
  brand: string;
  flavor: string;
  strength: Strength;
  /** Antal dosor som kan plockas (saldo minus reserverat). */
  available: number;
}

export interface PickPreferences {
  boxSize: number;
  strength?: Strength | null;
  preferredFlavors?: readonly string[];
  excludedFlavors?: readonly string[];
  /** Produkt-id som kunden redan fått i tidigare boxar. */
  previouslySent?: readonly number[];
  seed?: number;
}

export interface BoxPick {
  productId: number;
  quantity: number;
}

const norm = (s: string) => s.trim().toLowerCase();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseScore(c: PickCandidate, prefs: PickPreferences, preferred: Set<string>, sent: Set<number>): number {
  let score = 0;
  if (prefs.strength) {
    const d = strengthDistance(c.strength, prefs.strength);
    score += d === 0 ? 3 : d === 1 ? 1 : -3;
  }
  if (preferred.has(norm(c.flavor))) score += 2;
  if (sent.has(c.id)) score -= 2;
  return score;
}

export function pickMysteryBox(candidates: readonly PickCandidate[], prefs: PickPreferences): BoxPick[] {
  const excluded = new Set((prefs.excludedFlavors ?? []).map(norm));
  const preferred = new Set((prefs.preferredFlavors ?? []).map(norm));
  const sent = new Set(prefs.previouslySent ?? []);
  const rand = mulberry32(prefs.seed ?? 1);

  const pool = candidates
    .filter((c) => c.available > 0 && !excluded.has(norm(c.flavor)))
    .map((c) => ({ c, base: baseScore(c, prefs, preferred, sent), jitter: rand() }));

  const chosen = new Map<number, number>();
  const flavorCount = new Map<string, number>();
  const brandCount = new Map<string, number>();
  let total = 0;

  while (total < prefs.boxSize) {
    let best: (typeof pool)[number] | undefined;
    let bestScore = -Infinity;
    for (const entry of pool) {
      const already = chosen.get(entry.c.id) ?? 0;
      if (already >= entry.c.available) continue;
      const score =
        entry.base -
        2 * (flavorCount.get(norm(entry.c.flavor)) ?? 0) -
        1 * (brandCount.get(norm(entry.c.brand)) ?? 0) -
        4 * already +
        entry.jitter * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (!best) break; // lagret räcker inte till hela boxen
    chosen.set(best.c.id, (chosen.get(best.c.id) ?? 0) + 1);
    flavorCount.set(norm(best.c.flavor), (flavorCount.get(norm(best.c.flavor)) ?? 0) + 1);
    brandCount.set(norm(best.c.brand), (brandCount.get(norm(best.c.brand)) ?? 0) + 1);
    total++;
  }

  return [...chosen.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

export function totalQuantity(picks: readonly BoxPick[]): number {
  return picks.reduce((sum, p) => sum + p.quantity, 0);
}
