import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { config } from '../config.ts';
import { AppError, conflict, invalid, notFound } from '../domain/errors.ts';
import type { Strength } from '../domain/products.ts';
import { availableStock, getProduct } from './products.ts';

/**
 * Månadens box ("utgåva").
 *
 * Alla kunder får exakt samma innehåll en viss månad. Utgåvan sätts ihop en gång
 * och låses innan plockningen börjar; därefter hämtar varje order sitt boxinnehåll
 * härifrån i stället för att plockas individuellt.
 */

export type EditionStatus = 'draft' | 'locked' | 'archived';

export const EDITION_STATUS_LABELS: Record<EditionStatus, string> = {
  draft: 'Utkast',
  locked: 'Låst',
  archived: 'Arkiverad',
};

export interface BoxEdition {
  id: number;
  period: string;
  name: string;
  description: string | null;
  status: EditionStatus;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EditionItem {
  id: number;
  editionId: number;
  productId: number;
  quantity: number;
  position: number;
  sku: string;
  productName: string;
  brand: string;
  flavor: string;
  strength: Strength;
  supplierId: number | null;
  supplierName: string | null;
  stockOnHand: number;
  stockReserved: number;
}

export interface EditionDetail extends BoxEdition {
  items: EditionItem[];
  totalCans: number;
}

const PERIOD_RE = /^\d{4}-\d{2}$/;

export function assertPeriod(period: string): string {
  if (!PERIOD_RE.test(period)) throw invalid('INVALID_PERIOD', 'Period måste anges som ÅÅÅÅ-MM');
  return period;
}

export function periodLabel(period: string): string {
  const months = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
  const [year, month] = period.split('-');
  const name = months[Number(month) - 1];
  return name ? `${name} ${year}` : period;
}

export function createEdition(db: Db, input: { period: string; name?: string; description?: string | null }): EditionDetail {
  const period = assertPeriod(input.period);
  if (findEditionByPeriod(db, period)) throw conflict('EDITION_EXISTS', `Det finns redan en box för ${periodLabel(period)}`);
  const ts = now();
  const r = db
    .prepare('INSERT INTO box_editions (period, name, description, status, created_at, updated_at) VALUES (?, ?, ?, \'draft\', ?, ?)')
    .run(period, input.name?.trim() || `Mysterysnus ${periodLabel(period)}`, input.description?.trim() || null, ts, ts);
  return getEdition(db, Number(r.lastInsertRowid));
}

export function getEdition(db: Db, id: number): EditionDetail {
  const row = db.prepare('SELECT * FROM box_editions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const edition = toCamel<EditionDetail>(row);
  if (!edition) throw notFound('Box', id);
  edition.items = listEditionItems(db, id);
  edition.totalCans = edition.items.reduce((sum, i) => sum + i.quantity, 0);
  return edition;
}

export function findEditionByPeriod(db: Db, period: string): EditionDetail | undefined {
  const row = db.prepare('SELECT id FROM box_editions WHERE period = ?').get(assertPeriod(period)) as { id: number } | undefined;
  return row ? getEdition(db, row.id) : undefined;
}

export function listEditionItems(db: Db, editionId: number): EditionItem[] {
  return toCamelAll<EditionItem>(
    db
      .prepare(
        `SELECT i.*, p.sku, p.name AS product_name, p.brand, p.flavor, p.strength, p.supplier_id,
                s.name AS supplier_name, p.stock_on_hand, p.stock_reserved
         FROM box_edition_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE i.edition_id = ? ORDER BY i.position, p.brand, p.name`,
      )
      .all(editionId) as Record<string, unknown>[],
  );
}

export interface EditionListItem extends BoxEdition {
  totalCans: number;
  itemCount: number;
  orderCount: number;
  ratingCount: number;
}

export function listEditions(db: Db, opts: { limit?: number } = {}): EditionListItem[] {
  return toCamelAll<EditionListItem>(
    db
      .prepare(
        `SELECT e.*,
           (SELECT COALESCE(SUM(i.quantity), 0) FROM box_edition_items i WHERE i.edition_id = e.id) AS total_cans,
           (SELECT COUNT(*) FROM box_edition_items i WHERE i.edition_id = e.id) AS item_count,
           (SELECT COUNT(*) FROM orders o WHERE o.edition_id = e.id AND o.status != 'cancelled') AS order_count,
           (SELECT COUNT(*) FROM product_ratings r WHERE r.edition_id = e.id) AS rating_count
         FROM box_editions e ORDER BY e.period DESC LIMIT ?`,
      )
      .all(Math.min(opts.limit ?? 50, 200)) as Record<string, unknown>[],
  );
}

function assertEditable(edition: BoxEdition): void {
  if (edition.status !== 'draft') {
    throw new AppError(409, 'EDITION_LOCKED', `Boxen för ${periodLabel(edition.period)} är ${EDITION_STATUS_LABELS[edition.status].toLowerCase()} och kan inte ändras`);
  }
}

export function setEditionItem(db: Db, editionId: number, productId: number, quantity: number): EditionDetail {
  return transaction(db, () => {
    const edition = getEdition(db, editionId);
    assertEditable(edition);
    if (!Number.isInteger(quantity) || quantity < 0) throw invalid('INVALID_QUANTITY', 'Antal måste vara ett heltal ≥ 0');
    const product = getProduct(db, productId);
    if (quantity === 0) {
      db.prepare('DELETE FROM box_edition_items WHERE edition_id = ? AND product_id = ?').run(editionId, productId);
    } else {
      if (!product.active) throw invalid('PRODUCT_INACTIVE', `${product.sku} är inaktiv och kan inte ingå i boxen`);
      const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM box_edition_items WHERE edition_id = ?').get(editionId) as { p: number }).p;
      db.prepare(
        `INSERT INTO box_edition_items (edition_id, product_id, quantity, position) VALUES (?, ?, ?, ?)
         ON CONFLICT (edition_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
      ).run(editionId, productId, quantity, position);
    }
    db.prepare('UPDATE box_editions SET updated_at = ? WHERE id = ?').run(now(), editionId);
    return getEdition(db, editionId);
  });
}

export function replaceEditionItems(db: Db, editionId: number, items: { productId: number; quantity: number }[]): EditionDetail {
  return transaction(db, () => {
    const edition = getEdition(db, editionId);
    assertEditable(edition);
    db.prepare('DELETE FROM box_edition_items WHERE edition_id = ?').run(editionId);
    const insert = db.prepare('INSERT INTO box_edition_items (edition_id, product_id, quantity, position) VALUES (?, ?, ?, ?)');
    let position = 0;
    const seen = new Set<number>();
    for (const item of items) {
      if (item.quantity <= 0) continue;
      if (seen.has(item.productId)) throw invalid('DUPLICATE_PRODUCT', 'Samma produkt angavs två gånger');
      seen.add(item.productId);
      const product = getProduct(db, item.productId);
      if (!product.active) throw invalid('PRODUCT_INACTIVE', `${product.sku} är inaktiv och kan inte ingå i boxen`);
      insert.run(editionId, item.productId, item.quantity, position++);
    }
    db.prepare('UPDATE box_editions SET updated_at = ? WHERE id = ?').run(now(), editionId);
    return getEdition(db, editionId);
  });
}

export function updateEdition(db: Db, id: number, patch: { name?: string; description?: string | null }): EditionDetail {
  const edition = getEdition(db, id);
  db.prepare('UPDATE box_editions SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
    patch.name?.trim() || edition.name,
    patch.description === undefined ? edition.description : patch.description?.trim() || null,
    now(),
    id,
  );
  return getEdition(db, id);
}

/** Låser utgåvan så att innehållet inte kan ändras när plockningen börjat. */
export function lockEdition(db: Db, id: number, opts: { expectedCans?: number } = {}): EditionDetail {
  const edition = getEdition(db, id);
  if (edition.status === 'locked') return edition;
  if (edition.status === 'archived') throw new AppError(409, 'EDITION_ARCHIVED', 'Arkiverade boxar kan inte låsas');
  const expected = opts.expectedCans ?? config.defaultBoxSize;
  if (edition.totalCans !== expected) {
    throw invalid('WRONG_BOX_SIZE', `Boxen innehåller ${edition.totalCans} dosor men ska innehålla ${expected}`);
  }
  db.prepare("UPDATE box_editions SET status = 'locked', locked_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  return getEdition(db, id);
}

export function unlockEdition(db: Db, id: number): EditionDetail {
  const edition = getEdition(db, id);
  if (edition.status !== 'locked') return edition;
  const used = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE edition_id = ? AND status NOT IN ('pending', 'paid', 'cancelled')").get(id) as { n: number }).n;
  if (used > 0) throw new AppError(409, 'EDITION_IN_USE', `${used} order(s) är redan plockade med den här boxen och innehållet kan inte ändras`);
  db.prepare("UPDATE box_editions SET status = 'draft', locked_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  return getEdition(db, id);
}

export function archiveEdition(db: Db, id: number): EditionDetail {
  getEdition(db, id);
  db.prepare("UPDATE box_editions SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), id);
  return getEdition(db, id);
}

export interface EditionForecastRow {
  productId: number;
  sku: string;
  productName: string;
  brand: string;
  perBox: number;
  needed: number;
  available: number;
  shortfall: number;
}

export interface EditionForecast {
  boxesNeeded: number;
  ordersCreated: number;
  rows: EditionForecastRow[];
  totalShortfall: number;
}

/** Hur många dosor som behövs för alla aktiva prenumeranter, och vad som saknas i lager. */
export function editionForecast(db: Db, editionId: number): EditionForecast {
  const edition = getEdition(db, editionId);
  const boxesNeeded = (db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM subscriptions WHERE status = 'active'").get() as { n: number }).n;
  const ordersCreated = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE edition_id = ? AND status != 'cancelled'").get(editionId) as { n: number }).n;
  const rows: EditionForecastRow[] = edition.items.map((item) => {
    const needed = item.quantity * boxesNeeded;
    const available = availableStock({ stockOnHand: item.stockOnHand, stockReserved: item.stockReserved });
    return {
      productId: item.productId,
      sku: item.sku,
      productName: item.productName,
      brand: item.brand,
      perBox: item.quantity,
      needed,
      available,
      shortfall: Math.max(0, needed - available),
    };
  });
  return { boxesNeeded, ordersCreated, rows, totalShortfall: rows.reduce((sum, r) => sum + r.shortfall, 0) };
}
