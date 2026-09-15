export const SENTIMENTS = ['like', 'dislike', 'neutral'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  like: 'Gillar',
  dislike: 'Ogillar',
  neutral: 'Varken eller',
};

export function isSentiment(value: unknown): value is Sentiment {
  return typeof value === 'string' && (SENTIMENTS as readonly string[]).includes(value);
}

export function isRatingValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Andel i procent, avrundat till heltal. 0 svar ger 0. */
export function percent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

export function averageOrNull(sum: number, count: number): number | null {
  return count === 0 ? null : Math.round((sum / count) * 10) / 10;
}
