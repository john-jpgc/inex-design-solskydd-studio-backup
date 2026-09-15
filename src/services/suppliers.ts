import type { Db } from '../db/connection.ts';
import { now } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { conflict, invalid, notFound } from '../domain/errors.ts';

/** Leverantörer (snustillverkare). Loggdata om hur deras produkter tas emot rapporteras per leverantör. */

export interface Supplier {
  id: number;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInput {
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  active?: boolean;
}

const MAP = { bool: ['active'] };

export function createSupplier(db: Db, input: SupplierInput): Supplier {
  const name = input.name.trim();
  if (!name) throw invalid('MISSING_NAME', 'Leverantörens namn krävs');
  if (findSupplierByName(db, name)) throw conflict('SUPPLIER_EXISTS', `Leverantören ${name} finns redan`);
  const ts = now();
  const r = db
    .prepare('INSERT INTO suppliers (name, contact_name, contact_email, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, input.contactName?.trim() || null, input.contactEmail?.trim() || null, input.notes?.trim() || null, input.active === false ? 0 : 1, ts, ts);
  return getSupplier(db, Number(r.lastInsertRowid));
}

export function getSupplier(db: Db, id: number): Supplier {
  const s = toCamel<Supplier>(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Record<string, unknown> | undefined, MAP);
  if (!s) throw notFound('Leverantör', id);
  return s;
}

export function findSupplierByName(db: Db, name: string): Supplier | undefined {
  return toCamel<Supplier>(db.prepare('SELECT * FROM suppliers WHERE name = ?').get(name.trim()) as Record<string, unknown> | undefined, MAP);
}

/** Skapar leverantören om namnet är nytt – används vid import av produkter. */
export function upsertSupplierByName(db: Db, name: string): Supplier {
  return findSupplierByName(db, name) ?? createSupplier(db, { name });
}

export function listSuppliers(db: Db): Supplier[] {
  return toCamelAll<Supplier>(db.prepare('SELECT * FROM suppliers ORDER BY name').all() as Record<string, unknown>[], MAP);
}

export function updateSupplier(db: Db, id: number, patch: Partial<SupplierInput>): Supplier {
  const s = getSupplier(db, id);
  const name = patch.name?.trim() ?? s.name;
  if (name !== s.name) {
    const other = findSupplierByName(db, name);
    if (other && other.id !== id) throw conflict('SUPPLIER_EXISTS', `Leverantören ${name} finns redan`);
  }
  db.prepare('UPDATE suppliers SET name = ?, contact_name = ?, contact_email = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?').run(
    name,
    patch.contactName === undefined ? s.contactName : patch.contactName?.trim() || null,
    patch.contactEmail === undefined ? s.contactEmail : patch.contactEmail?.trim() || null,
    patch.notes === undefined ? s.notes : patch.notes?.trim() || null,
    patch.active === undefined ? (s.active ? 1 : 0) : patch.active ? 1 : 0,
    now(),
    id,
  );
  return getSupplier(db, id);
}
