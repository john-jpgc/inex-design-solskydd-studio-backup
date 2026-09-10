import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamelAll } from '../db/rows.ts';
import { invalid } from '../domain/errors.ts';
import { availableStock, getProduct, type Product } from './products.ts';

export type MovementReason = 'purchase' | 'adjustment' | 'pick' | 'return' | 'correction';

export interface StockMovement {
  id: number;
  productId: number;
  delta: number;
  reason: MovementReason;
  reference: string | null;
  note: string | null;
  createdAt: string;
}

function recordMovement(db: Db, productId: number, delta: number, reason: MovementReason, reference?: string, note?: string) {
  db.prepare(
    'INSERT INTO stock_movements (product_id, delta, reason, reference, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(productId, delta, reason, reference ?? null, note ?? null, now());
}

/** Ändrar fysiskt saldo (inleverans, inventering, retur). */
export function adjustStock(
  db: Db,
  productId: number,
  delta: number,
  reason: MovementReason,
  opts: { reference?: string; note?: string } = {},
): Product {
  if (!Number.isInteger(delta) || delta === 0) throw invalid('INVALID_DELTA', 'Ändringen måste vara ett heltal skilt från 0');
  return transaction(db, () => {
    const p = getProduct(db, productId);
    const next = p.stockOnHand + delta;
    if (next < p.stockReserved) {
      throw invalid(
        'INSUFFICIENT_STOCK',
        `Saldot för ${p.sku} kan inte bli ${next} eftersom ${p.stockReserved} st är reserverade`,
      );
    }
    db.prepare('UPDATE products SET stock_on_hand = ?, updated_at = ? WHERE id = ?').run(next, now(), productId);
    recordMovement(db, productId, delta, reason, opts.reference, opts.note);
    return getProduct(db, productId);
  });
}

/** Reserverar lager för en order. Saldot minskar först vid packning. */
export function reserveStock(db: Db, productId: number, quantity: number, reference: string): void {
  transaction(db, () => {
    const p = getProduct(db, productId);
    if (availableStock(p) < quantity) {
      throw invalid(
        'INSUFFICIENT_STOCK',
        `Endast ${availableStock(p)} st av ${p.sku} (${p.name}) är tillgängliga, ${quantity} begärdes`,
        { productId, sku: p.sku, available: availableStock(p), requested: quantity },
      );
    }
    db.prepare('UPDATE products SET stock_reserved = stock_reserved + ?, updated_at = ? WHERE id = ?').run(
      quantity, now(), productId,
    );
  });
  void reference;
}

export function releaseStock(db: Db, productId: number, quantity: number): void {
  db.prepare(
    'UPDATE products SET stock_reserved = MAX(0, stock_reserved - ?), updated_at = ? WHERE id = ?',
  ).run(quantity, now(), productId);
}

/** Drar reserverat lager från saldot (produkten har packats). */
export function commitReserved(db: Db, productId: number, quantity: number, reference: string): void {
  transaction(db, () => {
    const p = getProduct(db, productId);
    if (p.stockReserved < quantity || p.stockOnHand < quantity) {
      throw invalid('INSUFFICIENT_STOCK', `Reservationen för ${p.sku} täcker inte ${quantity} st`);
    }
    db.prepare(
      'UPDATE products SET stock_on_hand = stock_on_hand - ?, stock_reserved = stock_reserved - ?, updated_at = ? WHERE id = ?',
    ).run(quantity, quantity, now(), productId);
    recordMovement(db, productId, -quantity, 'pick', reference);
  });
}

/** Drar oreserverat lager direkt (t.ex. innehåll i en mystery-box). */
export function consumeStock(db: Db, productId: number, quantity: number, reference: string): void {
  transaction(db, () => {
    const p = getProduct(db, productId);
    if (availableStock(p) < quantity) {
      throw invalid(
        'INSUFFICIENT_STOCK',
        `Endast ${availableStock(p)} st av ${p.sku} (${p.name}) är tillgängliga, ${quantity} behövs`,
        { productId, sku: p.sku, available: availableStock(p), requested: quantity },
      );
    }
    db.prepare('UPDATE products SET stock_on_hand = stock_on_hand - ?, updated_at = ? WHERE id = ?').run(
      quantity, now(), productId,
    );
    recordMovement(db, productId, -quantity, 'pick', reference);
  });
}

export function listMovements(db: Db, productId: number, limit = 100): StockMovement[] {
  const rows = db
    .prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(productId, limit) as Record<string, unknown>[];
  return toCamelAll<StockMovement>(rows);
}
