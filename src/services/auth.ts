import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/connection.ts';
import { now } from '../db/connection.ts';
import { toCamel } from '../db/rows.ts';
import { config } from '../config.ts';
import { conflict, invalid } from '../domain/errors.ts';

export const STAFF_ROLES = ['admin', 'warehouse', 'support'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: 'Administratör',
  warehouse: 'Lager',
  support: 'Kundtjänst',
};

export interface StaffUser {
  id: number;
  email: string;
  name: string;
  role: StaffRole;
  active: boolean;
  createdAt: string;
}

const STAFF_COLUMNS = 'id, email, name, role, active, created_at';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createStaffUser(
  db: Db,
  input: { email: string; name: string; role: StaffRole; password: string },
): StaffUser {
  if (input.password.length < 8) throw invalid('WEAK_PASSWORD', 'Lösenordet måste vara minst 8 tecken');
  if (findStaffByEmail(db, input.email)) throw conflict('EMAIL_TAKEN', 'E-postadressen används redan');
  const ts = now();
  const result = db
    .prepare('INSERT INTO staff_users (email, name, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(input.email.trim().toLowerCase(), input.name.trim(), input.role, hashPassword(input.password), ts);
  return getStaffUser(db, Number(result.lastInsertRowid))!;
}

export function getStaffUser(db: Db, id: number): StaffUser | undefined {
  const row = db.prepare(`SELECT ${STAFF_COLUMNS} FROM staff_users WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return toCamel<StaffUser>(row, { bool: ['active'] });
}

export function findStaffByEmail(db: Db, email: string): StaffUser | undefined {
  const row = db.prepare(`SELECT ${STAFF_COLUMNS} FROM staff_users WHERE email = ?`).get(email.trim()) as
    | Record<string, unknown>
    | undefined;
  return toCamel<StaffUser>(row, { bool: ['active'] });
}

export function listStaff(db: Db): StaffUser[] {
  const rows = db.prepare(`SELECT ${STAFF_COLUMNS} FROM staff_users ORDER BY name`).all() as Record<string, unknown>[];
  return rows.map((r) => toCamel<StaffUser>(r, { bool: ['active'] })!);
}

/** Returnerar ett sessions-id vid lyckad inloggning, annars null. */
export function login(db: Db, email: string, password: string): string | null {
  const row = db.prepare('SELECT id, password_hash, active FROM staff_users WHERE email = ?').get(email.trim()) as
    | { id: number; password_hash: string; active: number }
    | undefined;
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) return null;
  const sessionId = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3_600_000).toISOString();
  db.prepare('INSERT INTO sessions (id, staff_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    sessionId,
    row.id,
    expires,
    now(),
  );
  return sessionId;
}

export function getSessionUser(db: Db, sessionId: string | undefined): StaffUser | undefined {
  if (!sessionId) return undefined;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at
       FROM sessions s JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(sessionId, now()) as Record<string, unknown> | undefined;
  return toCamel<StaffUser>(row, { bool: ['active'] });
}

export function logout(db: Db, sessionId: string | undefined): void {
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function purgeExpiredSessions(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}
