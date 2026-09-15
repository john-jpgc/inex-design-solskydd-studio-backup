import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { AppError, invalid, notFound } from '../domain/errors.ts';
import { isRatingValue, isSentiment, type Sentiment } from '../domain/ratings.ts';
import { getCustomer } from './customers.ts';
import { getEdition, type EditionDetail } from './editions.ts';

/**
 * Betyg på innehållet i en viss månads box.
 *
 * Betyget hör alltid ihop med både kunden och utgåvan, så att det går att följa
 * vad en enskild profil tyckte om just den boxen – och att summera per produkt
 * och leverantör.
 */

export interface ProductRating {
  id: number;
  customerId: number;
  editionId: number;
  productId: number;
  rating: number | null;
  sentiment: Sentiment | null;
  wouldBuyAgain: boolean | null;
  comment: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface RatingInput {
  customerId: number;
  editionId: number;
  productId: number;
  rating?: number | null;
  sentiment?: Sentiment | null;
  wouldBuyAgain?: boolean | null;
  comment?: string | null;
  source?: string;
  /** Hoppa över kontrollen att kunden fått boxen (import och rättelser från admin). */
  allowUnverified?: boolean;
}

const MAP = { bool: [] as string[] };

function mapRating(row: Record<string, unknown> | undefined): ProductRating | undefined {
  const r = toCamel<ProductRating>(row, MAP);
  if (r) r.wouldBuyAgain = row?.would_buy_again == null ? null : Boolean(row.would_buy_again);
  return r;
}

/** Kunden måste ha fått boxen för att få betygsätta den. */
export function hasReceivedEdition(db: Db, customerId: number, editionId: number): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM orders WHERE customer_id = ? AND edition_id = ? AND status NOT IN ('cancelled', 'pending') LIMIT 1")
    .get(customerId, editionId) as { ok: number } | undefined;
  return Boolean(row);
}

export function upsertProductRating(db: Db, input: RatingInput): ProductRating {
  return transaction(db, () => {
    getCustomer(db, input.customerId);
    const edition = getEdition(db, input.editionId);
    if (!edition.items.some((i) => i.productId === input.productId)) {
      throw invalid('PRODUCT_NOT_IN_BOX', 'Produkten ingick inte i den här månadens box');
    }
    if (!input.allowUnverified && !hasReceivedEdition(db, input.customerId, input.editionId)) {
      throw new AppError(403, 'BOX_NOT_RECEIVED', 'Kunden har inte fått den här boxen och kan inte betygsätta den');
    }
    if (input.rating != null && !isRatingValue(input.rating)) throw invalid('INVALID_RATING', 'Betyg måste vara 1–5');
    if (input.sentiment != null && !isSentiment(input.sentiment)) throw invalid('INVALID_SENTIMENT', 'Ogiltigt värde för gillar/ogillar');
    if (input.rating == null && input.sentiment == null && !input.comment?.trim() && input.wouldBuyAgain == null) {
      throw invalid('EMPTY_RATING', 'Ange betyg, gillar/ogillar, om kunden skulle köpa igen, eller en kommentar');
    }

    const ts = now();
    db.prepare(
      `INSERT INTO product_ratings (customer_id, edition_id, product_id, rating, sentiment, would_buy_again, comment, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (customer_id, edition_id, product_id) DO UPDATE SET
         rating = excluded.rating, sentiment = excluded.sentiment, would_buy_again = excluded.would_buy_again,
         comment = excluded.comment, source = excluded.source, updated_at = excluded.updated_at`,
    ).run(
      input.customerId, input.editionId, input.productId, input.rating ?? null, input.sentiment ?? null,
      input.wouldBuyAgain == null ? null : input.wouldBuyAgain ? 1 : 0, input.comment?.trim() || null,
      input.source?.trim() || 'web', ts, ts,
    );
    const row = db
      .prepare('SELECT * FROM product_ratings WHERE customer_id = ? AND edition_id = ? AND product_id = ?')
      .get(input.customerId, input.editionId, input.productId) as Record<string, unknown>;
    return mapRating(row)!;
  });
}

export interface EditionFeedback {
  id: number;
  customerId: number;
  editionId: number;
  rating: number | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export function upsertEditionFeedback(
  db: Db,
  input: { customerId: number; editionId: number; rating?: number | null; comment?: string | null; allowUnverified?: boolean },
): EditionFeedback {
  getCustomer(db, input.customerId);
  getEdition(db, input.editionId);
  if (!input.allowUnverified && !hasReceivedEdition(db, input.customerId, input.editionId)) {
    throw new AppError(403, 'BOX_NOT_RECEIVED', 'Kunden har inte fått den här boxen och kan inte betygsätta den');
  }
  if (input.rating != null && !isRatingValue(input.rating)) throw invalid('INVALID_RATING', 'Betyg måste vara 1–5');
  const ts = now();
  db.prepare(
    `INSERT INTO edition_feedback (customer_id, edition_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (customer_id, edition_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at`,
  ).run(input.customerId, input.editionId, input.rating ?? null, input.comment?.trim() || null, ts, ts);
  const row = db.prepare('SELECT * FROM edition_feedback WHERE customer_id = ? AND edition_id = ?').get(input.customerId, input.editionId) as Record<string, unknown>;
  return toCamel<EditionFeedback>(row)!;
}

export interface CustomerEditionRatings {
  edition: EditionDetail;
  received: boolean;
  feedback: EditionFeedback | null;
  ratings: (ProductRating & { sku: string; productName: string; brand: string })[];
}

/** Vad en kund tyckt om en viss box – underlag för "min profil" på hemsidan. */
export function getCustomerEditionRatings(db: Db, customerId: number, editionId: number): CustomerEditionRatings {
  const edition = getEdition(db, editionId);
  const rows = db
    .prepare(
      `SELECT r.*, p.sku, p.name AS product_name, p.brand FROM product_ratings r
       JOIN products p ON p.id = r.product_id WHERE r.customer_id = ? AND r.edition_id = ? ORDER BY p.brand, p.name`,
    )
    .all(customerId, editionId) as Record<string, unknown>[];
  const feedback = toCamel<EditionFeedback>(
    db.prepare('SELECT * FROM edition_feedback WHERE customer_id = ? AND edition_id = ?').get(customerId, editionId) as Record<string, unknown> | undefined,
  );
  return {
    edition,
    received: hasReceivedEdition(db, customerId, editionId),
    feedback: feedback ?? null,
    ratings: rows.map((row) => ({ ...(mapRating(row) as ProductRating), sku: String(row.sku), productName: String(row.product_name), brand: String(row.brand) })),
  };
}

export interface CustomerRatingHistoryRow {
  editionId: number;
  period: string;
  editionName: string;
  productId: number;
  sku: string;
  productName: string;
  brand: string;
  rating: number | null;
  sentiment: Sentiment | null;
  wouldBuyAgain: boolean | null;
  comment: string | null;
  createdAt: string;
}

/** Alla betyg en kund lämnat, senaste först. */
export function listCustomerRatings(db: Db, customerId: number, limit = 200): CustomerRatingHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT r.edition_id, e.period, e.name AS edition_name, r.product_id, p.sku, p.name AS product_name, p.brand,
              r.rating, r.sentiment, r.would_buy_again, r.comment, r.created_at
       FROM product_ratings r
       JOIN box_editions e ON e.id = r.edition_id
       JOIN products p ON p.id = r.product_id
       WHERE r.customer_id = ? ORDER BY e.period DESC, p.brand LIMIT ?`,
    )
    .all(customerId, limit) as Record<string, unknown>[];
  return rows.map((row) => {
    const mapped = toCamel<CustomerRatingHistoryRow>(row)!;
    mapped.wouldBuyAgain = row.would_buy_again == null ? null : Boolean(row.would_buy_again);
    return mapped;
  });
}

export interface RatingComment {
  customerId: number;
  customerName: string;
  rating: number | null;
  sentiment: Sentiment | null;
  comment: string;
  createdAt: string;
}

export function listComments(db: Db, opts: { editionId?: number; productId?: number; limit?: number } = {}): RatingComment[] {
  const where = ["r.comment IS NOT NULL AND r.comment != ''"];
  const params: (string | number)[] = [];
  if (opts.editionId != null) {
    where.push('r.edition_id = ?');
    params.push(opts.editionId);
  }
  if (opts.productId != null) {
    where.push('r.product_id = ?');
    params.push(opts.productId);
  }
  const rows = db
    .prepare(
      `SELECT r.customer_id, c.first_name || ' ' || c.last_name AS customer_name, r.rating, r.sentiment, r.comment, r.created_at
       FROM product_ratings r JOIN customers c ON c.id = r.customer_id
       WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(...params, Math.min(opts.limit ?? 100, 500)) as Record<string, unknown>[];
  return toCamelAll<RatingComment>(rows);
}

export function getEditionFeedbackSummary(db: Db, editionId: number): { responses: number; average: number | null } {
  const row = db.prepare('SELECT COUNT(rating) AS n, AVG(rating) AS avg FROM edition_feedback WHERE edition_id = ?').get(editionId) as { n: number; avg: number | null };
  return { responses: row.n, average: row.avg == null ? null : Math.round(row.avg * 10) / 10 };
}

export function findRating(db: Db, customerId: number, editionId: number, productId: number): ProductRating | undefined {
  return mapRating(
    db.prepare('SELECT * FROM product_ratings WHERE customer_id = ? AND edition_id = ? AND product_id = ?').get(customerId, editionId, productId) as
      | Record<string, unknown>
      | undefined,
  );
}

export function deleteRating(db: Db, id: number): void {
  const r = db.prepare('DELETE FROM product_ratings WHERE id = ?').run(id);
  if (r.changes === 0) throw notFound('Betyg', id);
}
