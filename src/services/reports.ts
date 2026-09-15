import type { Db } from '../db/connection.ts';
import { toCamelAll } from '../db/rows.ts';
import { averageOrNull, percent, type Sentiment } from '../domain/ratings.ts';
import { getEdition, periodLabel, type EditionDetail } from './editions.ts';
import { getEditionFeedbackSummary, listComments } from './ratings.ts';

/**
 * Loggdata till leverantörerna: hur deras snus togs emot i en viss månads box.
 *
 * Rapporten kombinerar betygen kunderna lämnat med hur många som klickat vidare
 * till en återförsäljare för att köpa mer, och kan filtreras till en enskild
 * leverantör innan den delas.
 */

export interface ProductReportRow {
  productId: number;
  sku: string;
  productName: string;
  brand: string;
  supplierId: number | null;
  supplierName: string | null;
  perBox: number;
  cansShipped: number;
  responses: number;
  averageRating: number | null;
  likes: number;
  dislikes: number;
  neutral: number;
  likeSharePercent: number;
  wouldBuyAgain: number;
  wouldBuyAgainSharePercent: number;
  clicks: number;
  clickCustomers: number;
  conversions: number;
  conversionValueOre: number;
  comments: { rating: number | null; sentiment: Sentiment | null; comment: string; createdAt: string }[];
}

export interface EditionReport {
  edition: EditionDetail;
  periodLabel: string;
  boxesShipped: number;
  ratedCustomers: number;
  boxRating: { responses: number; average: number | null };
  products: ProductReportRow[];
}

interface RawRatingRow {
  productId: number;
  responses: number;
  ratingSum: number | null;
  ratingCount: number;
  likes: number;
  dislikes: number;
  neutral: number;
  wouldBuyAgain: number;
}

interface RawClickRow {
  productId: number;
  clicks: number;
  clickCustomers: number;
  conversions: number;
  conversionValueOre: number;
}

export function editionReport(db: Db, editionId: number, opts: { supplierId?: number; includeComments?: boolean } = {}): EditionReport {
  const edition = getEdition(db, editionId);

  const boxesShipped = (
    db.prepare("SELECT COALESCE(SUM(l.quantity), 0) AS n FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE o.edition_id = ? AND l.kind = 'mystery_box' AND o.status IN ('shipped', 'delivered')").get(editionId) as { n: number }
  ).n;
  const ratedCustomers = (db.prepare('SELECT COUNT(DISTINCT customer_id) AS n FROM product_ratings WHERE edition_id = ?').get(editionId) as { n: number }).n;

  const ratingRows = toCamelAll<RawRatingRow>(
    db
      .prepare(
        `SELECT product_id,
           COUNT(*) AS responses,
           SUM(rating) AS rating_sum,
           COUNT(rating) AS rating_count,
           SUM(CASE WHEN sentiment = 'like' THEN 1 ELSE 0 END) AS likes,
           SUM(CASE WHEN sentiment = 'dislike' THEN 1 ELSE 0 END) AS dislikes,
           SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) AS neutral,
           SUM(CASE WHEN would_buy_again = 1 THEN 1 ELSE 0 END) AS would_buy_again
         FROM product_ratings WHERE edition_id = ? GROUP BY product_id`,
      )
      .all(editionId) as Record<string, unknown>[],
  );

  const clickRows = toCamelAll<RawClickRow>(
    db
      .prepare(
        `SELECT product_id, COUNT(*) AS clicks, COUNT(DISTINCT customer_id) AS click_customers,
           SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) AS conversions,
           COALESCE(SUM(conversion_value_ore), 0) AS conversion_value_ore
         FROM retailer_clicks WHERE edition_id = ? GROUP BY product_id`,
      )
      .all(editionId) as Record<string, unknown>[],
  );

  const products: ProductReportRow[] = edition.items
    .filter((item) => opts.supplierId == null || item.supplierId === opts.supplierId)
    .map((item) => {
      const r = ratingRows.find((x) => x.productId === item.productId);
      const c = clickRows.find((x) => x.productId === item.productId);
      const responses = r?.responses ?? 0;
      const likes = r?.likes ?? 0;
      const sentimentAnswers = (r?.likes ?? 0) + (r?.dislikes ?? 0) + (r?.neutral ?? 0);
      return {
        productId: item.productId,
        sku: item.sku,
        productName: item.productName,
        brand: item.brand,
        supplierId: item.supplierId,
        supplierName: item.supplierName,
        perBox: item.quantity,
        cansShipped: item.quantity * boxesShipped,
        responses,
        averageRating: averageOrNull(r?.ratingSum ?? 0, r?.ratingCount ?? 0),
        likes,
        dislikes: r?.dislikes ?? 0,
        neutral: r?.neutral ?? 0,
        likeSharePercent: percent(likes, sentimentAnswers),
        wouldBuyAgain: r?.wouldBuyAgain ?? 0,
        wouldBuyAgainSharePercent: percent(r?.wouldBuyAgain ?? 0, responses),
        clicks: c?.clicks ?? 0,
        clickCustomers: c?.clickCustomers ?? 0,
        conversions: c?.conversions ?? 0,
        conversionValueOre: c?.conversionValueOre ?? 0,
        comments: opts.includeComments
          ? listComments(db, { editionId, productId: item.productId, limit: 50 }).map((x) => ({
              rating: x.rating,
              sentiment: x.sentiment,
              comment: x.comment,
              createdAt: x.createdAt,
            }))
          : [],
      };
    });

  return {
    edition,
    periodLabel: periodLabel(edition.period),
    boxesShipped,
    ratedCustomers,
    boxRating: getEditionFeedbackSummary(db, editionId),
    products,
  };
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Semikolonseparerad CSV (öppnas direkt i svenskt Excel). */
export function editionReportCsv(db: Db, editionId: number, opts: { supplierId?: number } = {}): string {
  const report = editionReport(db, editionId, { ...opts, includeComments: false });
  const header = [
    'Period', 'Box', 'SKU', 'Produkt', 'Märke', 'Leverantör', 'Dosor per box', 'Dosor skickade',
    'Svar', 'Snittbetyg', 'Gillar', 'Ogillar', 'Varken eller', 'Andel gillar %',
    'Skulle köpa igen', 'Andel köpa igen %', 'Klick till återförsäljare', 'Unika kunder som klickat', 'Köp hos återförsäljare',
  ];
  const lines = [header.join(';')];
  for (const p of report.products) {
    lines.push(
      [
        report.edition.period, report.edition.name, p.sku, p.productName, p.brand, p.supplierName ?? '',
        p.perBox, p.cansShipped, p.responses, p.averageRating ?? '', p.likes, p.dislikes, p.neutral, p.likeSharePercent,
        p.wouldBuyAgain, p.wouldBuyAgainSharePercent, p.clicks, p.clickCustomers, p.conversions,
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `﻿${lines.join('\n')}\n`;
}

export interface ProductHistoryRow {
  editionId: number;
  period: string;
  responses: number;
  averageRating: number | null;
  likes: number;
  dislikes: number;
  clicks: number;
}

/** Hur en produkt tagits emot över tid, om den funnits i flera boxar. */
export function productHistory(db: Db, productId: number): ProductHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT e.id AS edition_id, e.period,
         COUNT(r.id) AS responses, AVG(r.rating) AS average_rating,
         SUM(CASE WHEN r.sentiment = 'like' THEN 1 ELSE 0 END) AS likes,
         SUM(CASE WHEN r.sentiment = 'dislike' THEN 1 ELSE 0 END) AS dislikes,
         (SELECT COUNT(*) FROM retailer_clicks c WHERE c.product_id = ? AND c.edition_id = e.id) AS clicks
       FROM box_editions e
       JOIN box_edition_items i ON i.edition_id = e.id AND i.product_id = ?
       LEFT JOIN product_ratings r ON r.edition_id = e.id AND r.product_id = ?
       GROUP BY e.id ORDER BY e.period DESC`,
    )
    .all(productId, productId, productId) as Record<string, unknown>[];
  return toCamelAll<ProductHistoryRow>(rows).map((r) => ({
    ...r,
    averageRating: r.averageRating == null ? null : Math.round(Number(r.averageRating) * 10) / 10,
  }));
}
