import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { config } from '../config.ts';
import { conflict, invalid, notFound } from '../domain/errors.ts';
import { getProduct } from './products.ts';

/**
 * Återförsäljare och spårning.
 *
 * Gillar en kund ett snus i månadens box ska hen kunna klicka sig vidare till en
 * återförsäljare och köpa mer. Varje klick loggas med kund, produkt och utgåva, och
 * får en unik referens som återförsäljaren kan rapportera tillbaka vid köp. Det gör
 * det möjligt att visa leverantören både betyg och faktiskt merköp.
 */

export interface Retailer {
  id: number;
  name: string;
  website: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RetailerLink {
  id: number;
  retailerId: number;
  productId: number;
  url: string;
  priceOre: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RetailerLinkView extends RetailerLink {
  retailerName: string;
  sku: string;
  productName: string;
  brand: string;
  /** Länk som loggar klicket och skickar kunden vidare. */
  trackingUrl: string;
  clicks: number;
  conversions: number;
}

const RETAILER_MAP = { bool: ['active'] };

export function createRetailer(db: Db, input: { name: string; website?: string | null; notes?: string | null }): Retailer {
  const name = input.name.trim();
  if (!name) throw invalid('MISSING_NAME', 'Återförsäljarens namn krävs');
  if (db.prepare('SELECT 1 FROM retailers WHERE name = ?').get(name)) throw conflict('RETAILER_EXISTS', `${name} finns redan`);
  const ts = now();
  const r = db
    .prepare('INSERT INTO retailers (name, website, notes, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(name, input.website?.trim() || null, input.notes?.trim() || null, ts, ts);
  return getRetailer(db, Number(r.lastInsertRowid));
}

export function getRetailer(db: Db, id: number): Retailer {
  const r = toCamel<Retailer>(db.prepare('SELECT * FROM retailers WHERE id = ?').get(id) as Record<string, unknown> | undefined, RETAILER_MAP);
  if (!r) throw notFound('Återförsäljare', id);
  return r;
}

export interface RetailerListItem extends Retailer {
  linkCount: number;
  clicks: number;
  conversions: number;
}

export function listRetailers(db: Db): RetailerListItem[] {
  return toCamelAll<RetailerListItem>(
    db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM retailer_links l WHERE l.retailer_id = r.id) AS link_count,
           (SELECT COUNT(*) FROM retailer_clicks c WHERE c.retailer_id = r.id) AS clicks,
           (SELECT COUNT(*) FROM retailer_clicks c WHERE c.retailer_id = r.id AND c.converted_at IS NOT NULL) AS conversions
         FROM retailers r ORDER BY r.name`,
      )
      .all() as Record<string, unknown>[],
    RETAILER_MAP,
  );
}

export function updateRetailer(db: Db, id: number, patch: { name?: string; website?: string | null; notes?: string | null; active?: boolean }): Retailer {
  const r = getRetailer(db, id);
  db.prepare('UPDATE retailers SET name = ?, website = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?').run(
    patch.name?.trim() || r.name,
    patch.website === undefined ? r.website : patch.website?.trim() || null,
    patch.notes === undefined ? r.notes : patch.notes?.trim() || null,
    patch.active === undefined ? (r.active ? 1 : 0) : patch.active ? 1 : 0,
    now(),
    id,
  );
  return getRetailer(db, id);
}

function assertHttpUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid('INVALID_URL', 'Länken måste vara en fullständig adress, t.ex. https://exempel.se/produkt');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('INVALID_URL', 'Länken måste börja med http:// eller https://');
  }
  return parsed.toString();
}

export function setRetailerLink(db: Db, input: { retailerId: number; productId: number; url: string; priceOre?: number | null; active?: boolean }): RetailerLink {
  getRetailer(db, input.retailerId);
  getProduct(db, input.productId);
  const url = assertHttpUrl(input.url);
  const ts = now();
  db.prepare(
    `INSERT INTO retailer_links (retailer_id, product_id, url, price_ore, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (retailer_id, product_id) DO UPDATE SET url = excluded.url, price_ore = excluded.price_ore, active = excluded.active, updated_at = excluded.updated_at`,
  ).run(input.retailerId, input.productId, url, input.priceOre ?? null, input.active === false ? 0 : 1, ts, ts);
  const row = db.prepare('SELECT * FROM retailer_links WHERE retailer_id = ? AND product_id = ?').get(input.retailerId, input.productId) as Record<string, unknown>;
  return toCamel<RetailerLink>(row, RETAILER_MAP)!;
}

export function deleteRetailerLink(db: Db, id: number): void {
  const r = db.prepare('DELETE FROM retailer_links WHERE id = ?').run(id);
  if (r.changes === 0) throw notFound('Återförsäljarlänk', id);
}

export function getRetailerLink(db: Db, id: number): RetailerLink {
  const l = toCamel<RetailerLink>(db.prepare('SELECT * FROM retailer_links WHERE id = ?').get(id) as Record<string, unknown> | undefined, RETAILER_MAP);
  if (!l) throw notFound('Återförsäljarlänk', id);
  return l;
}

/** Adressen hemsidan skickar kunden till. Klicket loggas innan vidarebefordran. */
export function trackingUrlFor(linkId: number, opts: { customerToken?: string | null; period?: string | null; source?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (opts.customerToken) params.set('t', opts.customerToken);
  if (opts.period) params.set('p', opts.period);
  if (opts.source) params.set('s', opts.source);
  const query = params.toString();
  return `${config.publicBaseUrl}/r/${linkId}${query ? `?${query}` : ''}`;
}

export function listLinksForProduct(db: Db, productId: number, opts: { customerToken?: string | null; period?: string | null } = {}): RetailerLinkView[] {
  const rows = db
    .prepare(
      `SELECT l.*, r.name AS retailer_name, p.sku, p.name AS product_name, p.brand,
         (SELECT COUNT(*) FROM retailer_clicks c WHERE c.link_id = l.id) AS clicks,
         (SELECT COUNT(*) FROM retailer_clicks c WHERE c.link_id = l.id AND c.converted_at IS NOT NULL) AS conversions
       FROM retailer_links l JOIN retailers r ON r.id = l.retailer_id JOIN products p ON p.id = l.product_id
       WHERE l.product_id = ? AND l.active = 1 AND r.active = 1 ORDER BY r.name`,
    )
    .all(productId) as Record<string, unknown>[];
  return toCamelAll<RetailerLinkView>(rows, RETAILER_MAP).map((l) => ({ ...l, trackingUrl: trackingUrlFor(l.id, opts) }));
}

export function listAllLinks(db: Db): RetailerLinkView[] {
  const rows = db
    .prepare(
      `SELECT l.*, r.name AS retailer_name, p.sku, p.name AS product_name, p.brand,
         (SELECT COUNT(*) FROM retailer_clicks c WHERE c.link_id = l.id) AS clicks,
         (SELECT COUNT(*) FROM retailer_clicks c WHERE c.link_id = l.id AND c.converted_at IS NOT NULL) AS conversions
       FROM retailer_links l JOIN retailers r ON r.id = l.retailer_id JOIN products p ON p.id = l.product_id
       ORDER BY p.brand, p.name, r.name`,
    )
    .all() as Record<string, unknown>[];
  return toCamelAll<RetailerLinkView>(rows, RETAILER_MAP).map((l) => ({ ...l, trackingUrl: trackingUrlFor(l.id) }));
}

export interface ClickResult {
  clickId: number;
  /** Adressen kunden ska skickas vidare till, med spårningsreferens. */
  redirectUrl: string;
  conversionRef: string;
}

/**
 * Loggar ett klick och returnerar adressen till återförsäljaren.
 * Okänd kundtoken loggas som anonymt klick i stället för att fela – länken ska alltid fungera.
 */
export function recordClick(
  db: Db,
  linkId: number,
  opts: { customerToken?: string | null; customerId?: number | null; period?: string | null; source?: string | null } = {},
): ClickResult {
  return transaction(db, () => {
    const link = getRetailerLink(db, linkId);
    if (!link.active) throw notFound('Återförsäljarlänk', linkId);

    let customerId = opts.customerId ?? null;
    if (customerId == null && opts.customerToken) {
      const row = db.prepare('SELECT id FROM customers WHERE public_token = ?').get(opts.customerToken.trim()) as { id: number } | undefined;
      customerId = row?.id ?? null;
    }
    let editionId: number | null = null;
    if (opts.period) {
      const row = db.prepare('SELECT id FROM box_editions WHERE period = ?').get(opts.period.trim()) as { id: number } | undefined;
      editionId = row?.id ?? null;
    }

    const conversionRef = `MSR-${randomBytes(8).toString('hex')}`;
    const r = db
      .prepare(
        `INSERT INTO retailer_clicks (link_id, retailer_id, product_id, customer_id, edition_id, source, created_at, conversion_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(linkId, link.retailerId, link.productId, customerId, editionId, opts.source?.trim() || null, now(), conversionRef);

    const url = new URL(link.url);
    url.searchParams.set('ref', conversionRef);
    return { clickId: Number(r.lastInsertRowid), redirectUrl: url.toString(), conversionRef };
  });
}

/** Återförsäljaren rapporterar att klicket ledde till ett köp. */
export function recordConversion(db: Db, conversionRef: string, opts: { valueOre?: number | null; occurredAt?: string | null } = {}): { clickId: number } {
  const row = db.prepare('SELECT id, converted_at FROM retailer_clicks WHERE conversion_ref = ?').get(conversionRef.trim()) as
    | { id: number; converted_at: string | null }
    | undefined;
  if (!row) throw notFound('Spårningsreferens', conversionRef);
  if (row.converted_at) return { clickId: row.id };
  db.prepare('UPDATE retailer_clicks SET converted_at = ?, conversion_value_ore = ? WHERE id = ?').run(
    opts.occurredAt ?? now(), opts.valueOre ?? null, row.id,
  );
  return { clickId: row.id };
}

export interface ClickStatsRow {
  productId: number;
  sku: string;
  productName: string;
  brand: string;
  retailerId: number;
  retailerName: string;
  clicks: number;
  uniqueCustomers: number;
  conversions: number;
  conversionValueOre: number;
}

export function clickStats(db: Db, opts: { editionId?: number; productId?: number } = {}): ClickStatsRow[] {
  const where: string[] = [];
  const params: number[] = [];
  if (opts.editionId != null) {
    where.push('c.edition_id = ?');
    params.push(opts.editionId);
  }
  if (opts.productId != null) {
    where.push('c.product_id = ?');
    params.push(opts.productId);
  }
  return toCamelAll<ClickStatsRow>(
    db
      .prepare(
        `SELECT c.product_id, p.sku, p.name AS product_name, p.brand, c.retailer_id, r.name AS retailer_name,
           COUNT(*) AS clicks, COUNT(DISTINCT c.customer_id) AS unique_customers,
           SUM(CASE WHEN c.converted_at IS NOT NULL THEN 1 ELSE 0 END) AS conversions,
           COALESCE(SUM(c.conversion_value_ore), 0) AS conversion_value_ore
         FROM retailer_clicks c JOIN products p ON p.id = c.product_id JOIN retailers r ON r.id = c.retailer_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         GROUP BY c.product_id, c.retailer_id ORDER BY clicks DESC`,
      )
      .all(...params) as Record<string, unknown>[],
  );
}
