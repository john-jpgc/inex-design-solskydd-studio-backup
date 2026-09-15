import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { config } from '../config.ts';
import { AppError, invalid, notFound } from '../domain/errors.ts';
import type { Strength } from '../domain/products.ts';
import { dayOfMonthFor, firstRenewalFor, isWave, nextRenewalFor, waveCount, waveForJoinDate, waveLabel } from '../domain/waves.ts';
import { assertOfAge, getCustomer } from './customers.ts';
import { createOrder, findOrderByNumber, type OrderDetail } from './orders.ts';
import { findEditionByPeriod } from './editions.ts';

/**
 * Prenumerationer: kunden får månadens box (standard 4 dosor) en gång i månaden.
 *
 * Alla kunder får samma innehåll, men inte nödvändigtvis samma dag: varje
 * prenumeration tillhör en utskicksvåg som styr vilken dag i månaden ordern skapas.
 * Se src/domain/waves.ts.
 *
 * Förnyelse skapar en order för perioden (ÅÅÅÅ-MM). Ordern får externalRef
 * "SUB-<id>-<period>" och är därmed idempotent – anropas förnyelsen två gånger
 * för samma period returneras den befintliga ordern. Betalningen sker hos
 * betalleverantören (Klarna/Stripe m.fl.); ordern skapas som obetald tills
 * webbshopen/betalleverantörens webhook markerar den betald, eller som betald
 * direkt om förnyelsen anropas med paymentStatus: "paid".
 */

export type SubscriptionStatus = 'active' | 'paused' | 'cancelled';

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: 'Aktiv',
  paused: 'Pausad',
  cancelled: 'Avslutad',
};

export interface Subscription {
  id: number;
  customerId: number;
  status: SubscriptionStatus;
  boxSize: number;
  quantity: number;
  strength: Strength | null;
  priceOre: number;
  intervalMonths: number;
  nextRenewalAt: string;
  lastRenewedAt: string | null;
  /** Utskicksvåg 1–4. Styr vilken dag i månaden boxen skickas, aldrig innehållet. */
  wave: number;
  externalRef: string | null;
  paymentMethod: string | null;
  notes: string | null;
  lastError: string | null;
  startedAt: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionListItem extends Subscription {
  customerName: string;
  customerEmail: string;
  orderCount: number;
}

export interface SubscriptionInput {
  customerId: number;
  boxSize?: number;
  quantity?: number;
  strength?: Strength | null;
  /** Pris per period i öre. Utelämnas → boxpris enligt config. */
  priceOre?: number;
  intervalMonths?: number;
  /** När första boxen ska skapas. Utelämnas → nästa utskicksdag för kundens våg. */
  startAt?: string;
  /** Utskicksvåg. Utelämnas → tilldelas efter när kunden gick med. */
  wave?: number;
  /** Id hos betalleverantören (t.ex. Stripe subscription id). Unikt. */
  externalRef?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
}

export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Lägger till månader och behåller dagen i månaden (klipps vid månadsslut). */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

export function createSubscription(db: Db, input: SubscriptionInput, actor = 'system'): Subscription {
  return transaction(db, () => {
    const customer = getCustomer(db, input.customerId);
    if (customer.status === 'blocked') throw new AppError(403, 'CUSTOMER_BLOCKED', 'Kunden är spärrad');
    assertOfAge(customer.birthDate);
    const boxSize = input.boxSize ?? config.defaultBoxSize;
    if (!Number.isInteger(boxSize) || boxSize <= 0) throw invalid('INVALID_BOX_SIZE', 'Boxstorlek måste vara ett positivt heltal');
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) throw invalid('INVALID_QUANTITY', 'Antal måste vara ett positivt heltal');
    const priceOre = input.priceOre ?? config.mysteryBoxPricesOre[boxSize];
    if (priceOre == null) throw invalid('UNKNOWN_BOX_SIZE', `Inget pris finns för box med ${boxSize} dosor – ange priceOre`);
    if (input.externalRef) {
      const dup = db.prepare('SELECT id FROM subscriptions WHERE external_ref = ?').get(input.externalRef) as { id: number } | undefined;
      if (dup) throw new AppError(409, 'DUPLICATE_SUBSCRIPTION', `Prenumerationen finns redan (#${dup.id})`);
    }
    const ts = now();
    const wave = input.wave != null ? input.wave : waveForJoinDate(ts);
    if (!isWave(wave)) throw invalid('INVALID_WAVE', 'Utskicksvåg måste vara 1–4');
    const startAt = input.startAt ?? firstRenewalFor(wave, ts);
    const result = db
      .prepare(
        `INSERT INTO subscriptions (customer_id, status, box_size, quantity, strength, price_ore, interval_months, next_renewal_at,
           wave, external_ref, payment_method, notes, started_at, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        customer.id, boxSize, quantity, input.strength ?? null, Math.round(priceOre), input.intervalMonths ?? 1, startAt,
        wave, input.externalRef ?? null, input.paymentMethod ?? null, input.notes?.trim() || null, ts, ts, ts,
      );
    void actor;
    return getSubscription(db, Number(result.lastInsertRowid));
  });
}

export function getSubscription(db: Db, id: number): Subscription {
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const s = toCamel<Subscription>(row);
  if (!s) throw notFound('Prenumeration', id);
  return s;
}

export function findSubscriptionByExternalRef(db: Db, externalRef: string): Subscription | undefined {
  const row = db.prepare('SELECT * FROM subscriptions WHERE external_ref = ?').get(externalRef.trim()) as Record<string, unknown> | undefined;
  return toCamel<Subscription>(row);
}

export function listSubscriptions(
  db: Db,
  opts: { status?: SubscriptionStatus; customerId?: number; q?: string; dueBefore?: string; limit?: number; offset?: number } = {},
): SubscriptionListItem[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push('s.status = ?');
    params.push(opts.status);
  }
  if (opts.customerId != null) {
    where.push('s.customer_id = ?');
    params.push(opts.customerId);
  }
  if (opts.dueBefore) {
    where.push('s.next_renewal_at <= ?');
    params.push(opts.dueBefore);
  }
  if (opts.q) {
    const like = `%${opts.q.trim()}%`;
    where.push('(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR s.external_ref LIKE ?)');
    params.push(like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT s.*, c.first_name || ' ' || c.last_name AS customer_name, c.email AS customer_email,
         (SELECT COUNT(*) FROM orders o WHERE o.subscription_id = s.id) AS order_count
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, s.next_renewal_at ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0) as Record<string, unknown>[];
  return toCamelAll<SubscriptionListItem>(rows);
}

export function subscriptionCounts(db: Db): Record<SubscriptionStatus, number> & { dueWithin7Days: number } {
  const counts = { active: 0, paused: 0, cancelled: 0, dueWithin7Days: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status').all() as { status: SubscriptionStatus; n: number }[]) {
    counts[r.status] = r.n;
  }
  const limit = new Date(Date.now() + 7 * 86_400_000).toISOString();
  counts.dueWithin7Days = (db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND next_renewal_at <= ?").get(limit) as { n: number }).n;
  return counts;
}

export function updateSubscription(
  db: Db,
  id: number,
  patch: { boxSize?: number; quantity?: number; strength?: Strength | null; priceOre?: number; intervalMonths?: number; nextRenewalAt?: string; wave?: number; paymentMethod?: string | null; notes?: string | null; externalRef?: string | null },
): Subscription {
  const s = getSubscription(db, id);
  if (patch.wave != null && !isWave(patch.wave)) throw invalid('INVALID_WAVE', 'Utskicksvåg måste vara 1–4');
  const boxSize = patch.boxSize ?? s.boxSize;
  const priceOre = patch.priceOre ?? (patch.boxSize != null && patch.boxSize !== s.boxSize ? config.mysteryBoxPricesOre[boxSize] : s.priceOre);
  if (priceOre == null) throw invalid('UNKNOWN_BOX_SIZE', `Inget pris finns för box med ${boxSize} dosor – ange priceOre`);
  db.prepare(
    `UPDATE subscriptions SET box_size = ?, quantity = ?, strength = ?, price_ore = ?, interval_months = ?, next_renewal_at = ?,
       wave = ?, payment_method = ?, notes = ?, external_ref = ?, updated_at = ? WHERE id = ?`,
  ).run(
    boxSize, patch.quantity ?? s.quantity, patch.strength === undefined ? s.strength : patch.strength, Math.round(priceOre),
    patch.intervalMonths ?? s.intervalMonths, patch.nextRenewalAt ?? s.nextRenewalAt, patch.wave ?? s.wave,
    patch.paymentMethod === undefined ? s.paymentMethod : patch.paymentMethod, patch.notes === undefined ? s.notes : patch.notes?.trim() || null,
    patch.externalRef === undefined ? s.externalRef : patch.externalRef, now(), id,
  );
  return getSubscription(db, id);
}

export function pauseSubscription(db: Db, id: number): Subscription {
  const s = getSubscription(db, id);
  if (s.status !== 'active') throw new AppError(409, 'INVALID_TRANSITION', 'Bara aktiva prenumerationer kan pausas');
  db.prepare("UPDATE subscriptions SET status = 'paused', updated_at = ? WHERE id = ?").run(now(), id);
  return getSubscription(db, id);
}

/** Återupptar en pausad prenumeration. Passerade förnyelsedatum flyttas fram till nu. */
export function resumeSubscription(db: Db, id: number): Subscription {
  const s = getSubscription(db, id);
  if (s.status !== 'paused') throw new AppError(409, 'INVALID_TRANSITION', 'Bara pausade prenumerationer kan återupptas');
  const ts = now();
  const next = s.nextRenewalAt < ts ? firstRenewalFor(s.wave, ts) : s.nextRenewalAt;
  db.prepare("UPDATE subscriptions SET status = 'active', next_renewal_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(next, ts, id);
  return getSubscription(db, id);
}

export function cancelSubscription(db: Db, id: number): Subscription {
  const s = getSubscription(db, id);
  if (s.status === 'cancelled') return s;
  const ts = now();
  db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
  return getSubscription(db, id);
}

export interface RenewOptions {
  /** Period (ÅÅÅÅ-MM). Utelämnas → perioden för nästa förnyelsedatum. */
  period?: string;
  paymentStatus?: 'unpaid' | 'paid';
  /** Betalleverantörens referens (t.ex. faktura-id). Skickas samma referens igen returneras den befintliga ordern. */
  paymentRef?: string | null;
  /** Om false flyttas inte nästa förnyelsedatum fram (t.ex. extra box). */
  advance?: boolean;
}

export function subscriptionOrderRef(subscriptionId: number, period: string): string {
  return `SUB-${subscriptionId}-${period}`;
}

/** Skapar periodens order (idempotent) och flyttar fram nästa förnyelse. */
export function renewSubscription(db: Db, id: number, opts: RenewOptions = {}, actor = 'system'): { order: OrderDetail; created: boolean; subscription: Subscription } {
  return transaction(db, () => {
    const s = getSubscription(db, id);
    if (s.status === 'cancelled') throw new AppError(409, 'SUBSCRIPTION_CANCELLED', 'Prenumerationen är avslutad');
    const period = opts.period ?? periodOf(s.nextRenewalAt);
    if (!/^\d{4}-\d{2}$/.test(period)) throw invalid('INVALID_PERIOD', 'Period måste anges som ÅÅÅÅ-MM');
    const ref = subscriptionOrderRef(id, period);

    // Idempotens: samma period, eller samma betalningsreferens (webhook som skickas om), ger samma order.
    const existingRow = db.prepare('SELECT order_number FROM orders WHERE subscription_id = ? AND period = ?').get(id, period) as { order_number: string } | undefined;
    if (existingRow) {
      return { order: findOrderByNumber(db, existingRow.order_number)!, created: false, subscription: s };
    }
    if (opts.paymentRef) {
      const byRef = db.prepare('SELECT order_number FROM orders WHERE subscription_id = ? AND payment_ref = ?').get(id, opts.paymentRef) as { order_number: string } | undefined;
      if (byRef) return { order: findOrderByNumber(db, byRef.order_number)!, created: false, subscription: s };
    }

    const customer = getCustomer(db, s.customerId);
    const edition = findEditionByPeriod(db, period);
    const order = createOrder(db, {
      customerId: customer.id,
      lines: [{ kind: 'mystery_box', boxSize: s.boxSize, quantity: s.quantity, strength: s.strength, unitPriceOre: Math.round(s.priceOre / s.quantity) }],
      channel: 'subscription',
      editionId: edition?.id ?? null,
      externalRef: ref,
      paymentMethod: s.paymentMethod,
      paymentStatus: opts.paymentStatus ?? 'unpaid',
      paymentRef: opts.paymentRef ?? null,
      customerNote: null,
    }, actor);
    db.prepare('UPDATE orders SET subscription_id = ?, period = ? WHERE id = ?').run(id, period, order.id);

    const ts = now();
    const advance = opts.advance ?? true;
    const nextRenewalAt = advance ? nextRenewalFor(s.wave, s.nextRenewalAt, s.intervalMonths) : s.nextRenewalAt;
    db.prepare('UPDATE subscriptions SET next_renewal_at = ?, last_renewed_at = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(nextRenewalAt, ts, ts, id);
    return { order: findOrderByNumber(db, order.orderNumber)!, created: true, subscription: getSubscription(db, id) };
  });
}

export interface RenewalRunResult {
  created: { subscriptionId: number; orderNumber: string }[];
  failed: { subscriptionId: number; error: string }[];
}

/** Skapar ordrar för alla aktiva prenumerationer vars förnyelsedatum passerat. */
export function renewDueSubscriptions(db: Db, at: string = now(), actor = 'scheduler'): RenewalRunResult {
  const due = db.prepare("SELECT id FROM subscriptions WHERE status = 'active' AND next_renewal_at <= ? ORDER BY next_renewal_at").all(at) as { id: number }[];
  const result: RenewalRunResult = { created: [], failed: [] };
  for (const { id } of due) {
    try {
      const r = renewSubscription(db, id, {}, actor);
      if (r.created) result.created.push({ subscriptionId: id, orderNumber: r.order.orderNumber });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare('UPDATE subscriptions SET last_error = ?, updated_at = ? WHERE id = ?').run(message, now(), id);
      result.failed.push({ subscriptionId: id, error: message });
    }
  }
  return result;
}

export interface WaveSummary {
  wave: number;
  label: string;
  dayOfMonth: number;
  active: number;
  paused: number;
  nextRenewalAt: string | null;
}

/** Hur många prenumeranter som ligger i varje utskicksvåg. */
export function waveSummary(db: Db): WaveSummary[] {
  const rows = db
    .prepare(
      `SELECT wave,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
         MIN(CASE WHEN status = 'active' THEN next_renewal_at END) AS next_renewal_at
       FROM subscriptions GROUP BY wave ORDER BY wave`,
    )
    .all() as { wave: number; active: number; paused: number; next_renewal_at: string | null }[];
  const waves = waveCount();
  const out: WaveSummary[] = [];
  for (let w = 1; w <= waves; w++) {
    const row = rows.find((r) => r.wave === w);
    out.push({
      wave: w,
      label: waveLabel(w),
      dayOfMonth: dayOfMonthFor(w),
      active: row?.active ?? 0,
      paused: row?.paused ?? 0,
      nextRenewalAt: row?.next_renewal_at ?? null,
    });
  }
  // Prenumeranter i vågar som inte längre används (t.ex. efter byte till "single").
  for (const row of rows) {
    if (row.wave > waves) {
      out.push({ wave: row.wave, label: `Våg ${row.wave} (används inte)`, dayOfMonth: dayOfMonthFor(row.wave), active: row.active, paused: row.paused, nextRenewalAt: row.next_renewal_at });
    }
  }
  return out;
}

/**
 * Fördelar prenumeranter i vågor utifrån när de gick med och flyttar nästa
 * förnyelse till vågens dag. Körs när man går från "alla samtidigt" till veckovis.
 */
export function assignWaves(db: Db): { updated: number } {
  return transaction(db, () => {
    const subs = db.prepare("SELECT id, started_at, wave, next_renewal_at, status FROM subscriptions WHERE status != 'cancelled'").all() as {
      id: number;
      started_at: string;
      wave: number;
      next_renewal_at: string;
      status: string;
    }[];
    let updated = 0;
    const ts = now();
    for (const sub of subs) {
      const wave = waveForJoinDate(sub.started_at);
      const nextRenewalAt = sub.next_renewal_at < ts ? sub.next_renewal_at : firstRenewalFor(wave, ts);
      if (wave === sub.wave && nextRenewalAt === sub.next_renewal_at) continue;
      db.prepare('UPDATE subscriptions SET wave = ?, next_renewal_at = ?, updated_at = ? WHERE id = ?').run(wave, nextRenewalAt, ts, sub.id);
      updated++;
    }
    return { updated };
  });
}
