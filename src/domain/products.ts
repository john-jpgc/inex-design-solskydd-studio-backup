export const STRENGTHS = ['mild', 'medium', 'strong', 'extra_strong'] as const;
export type Strength = (typeof STRENGTHS)[number];

export const STRENGTH_LABELS: Record<Strength, string> = {
  mild: 'Mild',
  medium: 'Medel',
  strong: 'Stark',
  extra_strong: 'Extra stark',
};

export const FORMATS = ['original', 'slim', 'mini', 'large'] as const;
export type ProductFormat = (typeof FORMATS)[number];

export function isStrength(value: unknown): value is Strength {
  return typeof value === 'string' && (STRENGTHS as readonly string[]).includes(value);
}

/** Avstånd mellan två styrkor (0 = samma, 1 = intilliggande, ...). */
export function strengthDistance(a: Strength, b: Strength): number {
  return Math.abs(STRENGTHS.indexOf(a) - STRENGTHS.indexOf(b));
}
