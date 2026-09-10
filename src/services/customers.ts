import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { config } from '../config.ts';
import { conflict, invalid, notFound } from '../domain/errors.ts';
import type { Strength } from '../domain/products.ts';

export interface Customer {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  birthDate: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  marketingConsent: boolean;
  prefStrength: Strength | null;
  prefFlavors: string[];
  excludedFlavors: string[];
  notes: string | null;
  status: 'active' | 'blocked';
  createdAt: string;
  updatedAt: string;
}

export interface CustomerInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  /** Format ÅÅÅÅ-MM-DD. Krävs för ålderskontroll (18 år). */
  birthDate: string;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string;
  marketingConsent?: boolean;
  prefStrength?: Strength | null;
  prefFlavors?: string[];
  excludedFlavors?: string[];
  notes?: string | null;
}

export type CustomerPatch = Partial<CustomerInput> & { status?: 'active' | 'blocked' };

const MAP_OPTS = { json: ['prefFlavors', 'excludedFlavors'], bool: ['marketingConsent'] };

export function fullName(c: { firstName: string; lastName: string }): string {
  return `${c.firstName} ${c.lastName}`.trim();
}

export function parseBirthDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('INVALID_BIRTH_DATE', 'Födelsedatum måste anges som ÅÅÅÅ-MM-DD');
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw invalid('INVALID_BIRTH_DATE', 'Ogiltigt födelsedatum');
  }
  return d;
}

export function ageOnDate(birthDate: string, at: Date = new Date()): number {
  const birth = parseBirthDate(birthDate);
  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < birth.getUTCMonth() ||
    (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export function assertOfAge(birthDate: string, at: Date = new Date()): void {
  if (ageOnDate(birthDate, at) < config.minAge) {
    throw invalid('UNDERAGE', `Kunden måste vara minst ${config.minAge} år för att beställa`);
  }
}

function normalizeInput(input: CustomerInput) {
  parseBirthDate(input.birthDate);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('INVALID_EMAIL', 'Ogiltig e-postadress');
  return {
    email,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    phone: input.phone?.trim() || null,
    birthDate: input.birthDate,
    street: input.street?.trim() || null,
    postalCode: input.postalCode?.replace(/\s+/g, '') || null,
    city: input.city?.trim() || null,
    country: (input.country ?? 'SE').toUpperCase(),
    marketingConsent: input.marketingConsent ? 1 : 0,
    prefStrength: input.prefStrength ?? null,
    prefFlavors: JSON.stringify(input.prefFlavors ?? []),
    excludedFlavors: JSON.stringify(input.excludedFlavors ?? []),
    notes: input.notes?.trim() || null,
  };
}

export function createCustomer(db: Db, input: CustomerInput): Customer {
  const v = normalizeInput(input);
  if (!v.firstName || !v.lastName) throw invalid('MISSING_NAME', 'För- och efternamn krävs');
  if (findCustomerByEmail(db, v.email)) throw conflict('EMAIL_TAKEN', 'Det finns redan en kund med den e-postadressen');
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO customers (email, first_name, last_name, phone, birth_date, street, postal_code, city, country,
        marketing_consent, pref_strength, pref_flavors, excluded_flavors, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      v.email, v.firstName, v.lastName, v.phone, v.birthDate, v.street, v.postalCode, v.city, v.country,
      v.marketingConsent, v.prefStrength, v.prefFlavors, v.excludedFlavors, v.notes, ts, ts,
    );
  return getCustomer(db, Number(result.lastInsertRowid));
}

const PATCH_COLUMNS: Record<string, string> = {
  email: 'email',
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  birthDate: 'birth_date',
  street: 'street',
  postalCode: 'postal_code',
  city: 'city',
  country: 'country',
  marketingConsent: 'marketing_consent',
  prefStrength: 'pref_strength',
  prefFlavors: 'pref_flavors',
  excludedFlavors: 'excluded_flavors',
  notes: 'notes',
  status: 'status',
};

export function updateCustomer(db: Db, id: number, patch: CustomerPatch): Customer {
  const existing = getCustomer(db, id);
  const merged: CustomerInput = { ...existing, ...stripUndefined(patch) };
  const v = normalizeInput(merged);
  const values: Record<string, unknown> = { ...v, status: patch.status ?? existing.status };
  if (v.email !== existing.email) {
    const other = findCustomerByEmail(db, v.email);
    if (other && other.id !== id) throw conflict('EMAIL_TAKEN', 'Det finns redan en kund med den e-postadressen');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    if (!(key in values)) continue;
    sets.push(`${column} = ?`);
    params.push(values[key]);
  }
  sets.push('updated_at = ?');
  params.push(now(), id);
  db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...(params as (string | number | null)[]));
  return getCustomer(db, id);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Skapar kunden om e-posten är ny, annars uppdateras adress och preferenser. */
export function upsertCustomerByEmail(db: Db, input: CustomerInput): Customer {
  return transaction(db, () => {
    const existing = findCustomerByEmail(db, input.email);
    if (!existing) return createCustomer(db, input);
    return updateCustomer(db, existing.id, input);
  });
}

export function getCustomer(db: Db, id: number): Customer {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const c = toCamel<Customer>(row, MAP_OPTS);
  if (!c) throw notFound('Kund', id);
  return c;
}

export function findCustomerByEmail(db: Db, email: string): Customer | undefined {
  const row = db.prepare('SELECT * FROM customers WHERE email = ?').get(email.trim().toLowerCase()) as
    | Record<string, unknown>
    | undefined;
  return toCamel<Customer>(row, MAP_OPTS);
}

export interface CustomerListItem extends Customer {
  orderCount: number;
  lifetimeValueOre: number;
}

export function listCustomers(
  db: Db,
  opts: { q?: string; limit?: number; offset?: number } = {},
): CustomerListItem[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    const like = `%${opts.q.trim()}%`;
    where.push('(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ? OR c.city LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ('cancelled')) AS order_count,
         (SELECT COALESCE(SUM(o.total_ore), 0) FROM orders o WHERE o.customer_id = c.id AND o.payment_status IN ('paid')) AS lifetime_value_ore
       FROM customers c
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  return toCamelAll<CustomerListItem>(rows, MAP_OPTS);
}

export function countCustomers(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
}
