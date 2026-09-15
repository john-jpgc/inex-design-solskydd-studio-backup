/** Alla belopp lagras som heltal i öre för att undvika flyttalsfel. */

export function vatFromGross(grossOre: number, vatRatePercent: number): number {
  const net = Math.round(grossOre / (1 + vatRatePercent / 100));
  return grossOre - net;
}

export function formatSek(ore: number): string {
  const negative = ore < 0;
  const abs = Math.abs(ore);
  const kronor = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = kronor.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const decimals = rest === 0 ? '' : `,${rest.toString().padStart(2, '0')}`;
  return `${negative ? '-' : ''}${grouped}${decimals} kr`;
}

export function kronorToOre(kronor: number): number {
  return Math.round(kronor * 100);
}
