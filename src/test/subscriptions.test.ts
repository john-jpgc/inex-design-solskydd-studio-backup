import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomer, seedProduct, testDb } from './helpers.ts';
import {
  addMonths, cancelSubscription, createSubscription, pauseSubscription, renewDueSubscriptions, renewSubscription, resumeSubscription,
} from '../services/subscriptions.ts';
import { getOrder, listOrders } from '../services/orders.ts';
import { config } from '../config.ts';
import { AppError } from '../domain/errors.ts';

test('addMonths behåller dagen och klipper vid månadsslut', () => {
  assert.equal(addMonths('2026-01-31T10:00:00.000Z', 1), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonths('2026-03-15T10:00:00.000Z', 1), '2026-04-15T10:00:00.000Z');
  assert.equal(addMonths('2026-12-05T00:00:00.000Z', 1), '2027-01-05T00:00:00.000Z');
});

test('prenumeration skapar en 4-box per månad, idempotent per period', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  seedProduct(db, 'A', 50);
  const sub = createSubscription(db, { customerId: customer.id, startAt: '2026-09-01T08:00:00.000Z' });
  assert.equal(sub.boxSize, config.defaultBoxSize);
  assert.equal(sub.priceOre, config.mysteryBoxPricesOre[4]);

  const first = renewSubscription(db, sub.id, { paymentStatus: 'paid', paymentRef: 'KL-1' });
  assert.equal(first.created, true);
  assert.equal(first.order.status, 'paid');
  assert.equal(first.order.channel, 'subscription');
  assert.equal(first.order.externalRef, `SUB-${sub.id}-2026-09`);
  assert.equal(first.order.lines[0]?.boxSize, 4);
  assert.equal(first.order.totalOre, config.mysteryBoxPricesOre[4]! + config.shipping.standardOre);
  assert.equal(first.subscription.nextRenewalAt, '2026-10-01T08:00:00.000Z');

  const again = renewSubscription(db, sub.id, { period: '2026-09' });
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);

  // Webhook som skickas om med samma betalningsreferens skapar ingen ny order
  const retry = renewSubscription(db, sub.id, { paymentStatus: 'paid', paymentRef: 'KL-1' });
  assert.equal(retry.created, false);
  assert.equal(retry.order.id, first.order.id);

  // Nästa månad med ny referens ger en ny order
  const next = renewSubscription(db, sub.id, { paymentStatus: 'paid', paymentRef: 'KL-2' });
  assert.equal(next.created, true);
  assert.equal(next.order.period, '2026-10');
  assert.equal(listOrders(db, { customerId: customer.id }).length, 2);
  assert.equal(getOrder(db, first.order.id).subscriptionId, sub.id);
});

test('förfallna prenumerationer förnyas av schemakörningen, pausade hoppas över', () => {
  const db = testDb();
  const c1 = seedCustomer(db);
  const c2 = seedCustomer(db, { email: 'b@example.com' });
  const c3 = seedCustomer(db, { email: 'c@example.com' });
  seedProduct(db, 'A', 50);
  const due = createSubscription(db, { customerId: c1.id, startAt: '2026-09-01T00:00:00.000Z' });
  const future = createSubscription(db, { customerId: c2.id, startAt: '2026-10-15T00:00:00.000Z' });
  const paused = createSubscription(db, { customerId: c3.id, startAt: '2026-09-01T00:00:00.000Z' });
  pauseSubscription(db, paused.id);

  const result = renewDueSubscriptions(db, '2026-09-10T00:00:00.000Z');
  assert.deepEqual(result.created.map((r) => r.subscriptionId), [due.id]);
  assert.equal(result.failed.length, 0);
  assert.equal(listOrders(db, { customerId: c2.id }).length, 0);
  void future;

  // Andra körningen samma dag skapar inget nytt
  const second = renewDueSubscriptions(db, '2026-09-10T00:00:00.000Z');
  assert.equal(second.created.length, 0);
});

test('återupptagen prenumeration får framflyttat förnyelsedatum om det passerat', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const sub = createSubscription(db, { customerId: customer.id, startAt: '2020-01-01T00:00:00.000Z' });
  pauseSubscription(db, sub.id);
  const resumed = resumeSubscription(db, sub.id);
  assert.ok(resumed.nextRenewalAt > '2025-01-01');
  const cancelled = cancelSubscription(db, sub.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => renewSubscription(db, sub.id), (e: unknown) => e instanceof AppError && e.code === 'SUBSCRIPTION_CANCELLED');
});

test('förnyelse misslyckas snyggt utan leveransadress och sparar felet', () => {
  const db = testDb();
  const customer = seedCustomer(db, { street: null, postalCode: null, city: null });
  const sub = createSubscription(db, { customerId: customer.id, startAt: '2026-09-01T00:00:00.000Z' });
  const result = renewDueSubscriptions(db, '2026-09-02T00:00:00.000Z');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.subscriptionId, sub.id);
  assert.match(result.failed[0]?.error ?? '', /Leveransadress/);
});
