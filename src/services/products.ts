import type { Db } from '../db/connection.ts';
import { now } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { config } from '../config.ts';
import { conflict, invalid, notFound } from '../domain/errors.ts';
import type { ProductFormat, Strength } from '../domain/products.ts';

export interface Product {
  id: number;
  sku: string;
  name: string;
  brand: string;
  flavor: string;
  strength: Strength;
  nicotineMg: number | null;
  format: ProductFormat;
  priceOre: number;
  vatRate: number;
  weightGrams: number;
  active: boolean;
  stockOnHand: number;
  stockReserved: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  brand: string;
  flavor: string;
  strength: Strength;
  nicotineMg?: number | null;
  format?: ProductFormat;
  priceOre: number;
  vatRate?: number;
  weightGrams?: number;
  active?: boolean;
}

const MAP_OPTS = { bool: ['active'] };

export function availableStock(p: Pick<Product, 'stockOnHand' | 'stockReserved'>): number {
  return p.stockOnHand - p.stockReserved;
}

export function isLowStock(p: Pick<Product, 'stockOnHand' | 'stockReserved'>): boolean {
  return availableStock(p) <= config.lowStockThreshold;
}

export function createProduct(db: Db, input: ProductInput): Product {
  const sku = input.sku.trim().toUpperCase();
  if (!sku) throw invalid('MISSING_SKU', 'SKU krävs');
  if (input.priceOre < 0) throw invalid('INVALID_PRICE', 'Priset kan inte vara negativt');
  if (findProductBySku(db, sku)) throw conflict('SKU_TAKEN', `SKU ${sku} finns redan`);
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO products (sku, name, brand, flavor, strength, nicotine_mg, format, price_ore, vat_rate, weight_grams, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sku, input.name.trim(), input.brand.trim(), input.flavor.trim(), input.strength, input.nicotineMg ?? null,
      input.format ?? 'slim', Math.round(input.priceOre), input.vatRate ?? config.vatRate, input.weightGrams ?? 20,
      input.active === false ? 0 : 1, ts, ts,
    );
  return getProduct(db, Number(result.lastInsertRowid));
}

const PATCH_COLUMNS: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  brand: 'brand',
  flavor: 'flavor',
  strength: 'strength',
  nicotineMg: 'nicotine_mg',
  format: 'format',
  priceOre: 'price_ore',
  vatRate: 'vat_rate',
  weightGrams: 'weight_grams',
  active: 'active',
};

export function updateProduct(db: Db, id: number, patch: Partial<ProductInput>): Product {
  getProduct(db, id);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'sku') {
      const sku = String(value).trim().toUpperCase();
      const other = findProductBySku(db, sku);
      if (other && other.id !== id) throw conflict('SKU_TAKEN', `SKU ${sku} finns redan`);
      params.push(sku);
    } else if (key === 'active') params.push(value ? 1 : 0);
    else if (typeof value === 'number') params.push(Math.round(value));
    else params.push(value === null ? null : String(value).trim());
    sets.push(`${column} = ?`);
  }
  if (sets.length === 0) return getProduct(db, id);
  sets.push('updated_at = ?');
  params.push(now(), id);
  db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProduct(db, id);
}

export function getProduct(db: Db, id: number): Product {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const p = toCamel<Product>(row, MAP_OPTS);
  if (!p) throw notFound('Produkt', id);
  return p;
}

export function findProductBySku(db: Db, sku: string): Product | undefined {
  const row = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku.trim()) as Record<string, unknown> | undefined;
  return toCamel<Product>(row, MAP_OPTS);
}

export function listProducts(
  db: Db,
  opts: { q?: string; activeOnly?: boolean; inStockOnly?: boolean; lowStockOnly?: boolean } = {},
): Product[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.activeOnly) where.push('active = 1');
  if (opts.inStockOnly) where.push('stock_on_hand - stock_reserved > 0');
  if (opts.lowStockOnly) {
    where.push('stock_on_hand - stock_reserved <= ?');
    params.push(config.lowStockThreshold);
  }
  if (opts.q) {
    const like = `%${opts.q.trim()}%`;
    where.push('(sku LIKE ? OR name LIKE ? OR brand LIKE ? OR flavor LIKE ?)');
    params.push(like, like, like, like);
  }
  const rows = db
    .prepare(`SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY brand, name`)
    .all(...params) as Record<string, unknown>[];
  return toCamelAll<Product>(rows, MAP_OPTS);
}
