import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.ts';
import { dayOfMonthFor, firstRenewalFor, nextRenewalFor, waveCount, waveForJoinDate } from '../domain/waves.ts';
import { seedCustomer, testDb } from './helpers.ts';
import { assignWaves, createSubscription, getSubscription, renewDueSubscriptions, waveSummary } from '../services/subscriptions.ts';

function withMode<T>(mode: 'single' | 'weekly', fn: () => T): T {
  const previous = config.waves.mode;
  config.waves.mode = mode;
  try {
    return fn();
  } finally {
    config.waves.mode = previous;
  }
}

test('i "single"-läge hamnar alla i samma våg', () => {
  withMode('single', () => {
    assert.equal(waveCount(), 1);
    assert.equal(waveForJoinDate('2026-09-23T10:00:00.000Z'), 1);
    assert.equal(waveForJoinDate('2026-09-02T10:00:00.000Z'), 1);
  });
});

test('i "weekly"-läge delas kunderna efter när de gick med', () => {
  withMode('weekly', () => {
    assert.equal(waveCount(), 4);
    assert.equal(waveForJoinDate('2026-09-01T10:00:00.000Z'), 1);
    assert.equal(waveForJoinDate('2026-09-07T10:00:00.000Z'), 1);
    assert.equal(waveForJoinDate('2026-09-08T10:00:00.000Z'), 2);
    assert.equal(waveForJoinDate('2026-09-14T10:00:00.000Z'), 2);
    assert.equal(waveForJoinDate('2026-09-15T10:00:00.000Z'), 3);
    assert.equal(waveForJoinDate('2026-09-22T10:00:00.000Z'), 4);
    assert.equal(waveForJoinDate('2026-09-30T10:00:00.000Z'), 4);
    assert.deepEqual([1, 2, 3, 4].map(dayOfMonthFor), [1, 8, 15, 22]);
  });
});

test('förnyelsedatum läggs på vågens dag', () => {
  withMode('weekly', () => {
    assert.equal(firstRenewalFor(3, '2026-09-10T00:00:00.000Z'), '2026-09-15T06:00:00.000Z');
    assert.equal(firstRenewalFor(1, '2026-09-10T00:00:00.000Z'), '2026-10-01T06:00:00.000Z', 'passerad dag hoppar till nästa månad');
    assert.equal(nextRenewalFor(3, '2026-09-15T06:00:00.000Z'), '2026-10-15T06:00:00.000Z');
    assert.equal(nextRenewalFor(4, '2026-01-22T06:00:00.000Z'), '2026-02-22T06:00:00.000Z');
  });
});

test('prenumeranter fördelas i vågor och förnyas olika dagar', () => {
  withMode('weekly', () => {
    const db = testDb();
    const early = seedCustomer(db, { email: 'tidig@example.com' });
    const late = seedCustomer(db, { email: 'sen@example.com' });
    const a = createSubscription(db, { customerId: early.id, wave: 1, startAt: '2026-10-01T06:00:00.000Z' });
    const b = createSubscription(db, { customerId: late.id, wave: 3, startAt: '2026-10-15T06:00:00.000Z' });
    assert.equal(a.wave, 1);
    assert.equal(b.wave, 3);

    // Den 2 oktober är bara våg 1 förfallen.
    const run = renewDueSubscriptions(db, '2026-10-02T00:00:00.000Z');
    assert.deepEqual(run.created.map((r) => r.subscriptionId), [a.id]);
    assert.equal(getSubscription(db, a.id).nextRenewalAt, '2026-11-01T06:00:00.000Z');

    const summary = waveSummary(db);
    assert.equal(summary.length, 4);
    assert.equal(summary[0]?.active, 1);
    assert.equal(summary[2]?.active, 1);
    assert.equal(summary[1]?.active, 0);
  });
});

test('assignWaves fördelar befintliga prenumeranter efter startdatum', () => {
  const db = testDb();
  const c1 = seedCustomer(db, { email: 'a@example.com' });
  const c2 = seedCustomer(db, { email: 'b@example.com' });
  const s1 = createSubscription(db, { customerId: c1.id });
  const s2 = createSubscription(db, { customerId: c2.id });
  db.prepare("UPDATE subscriptions SET started_at = '2026-09-03T10:00:00.000Z' WHERE id = ?").run(s1.id);
  db.prepare("UPDATE subscriptions SET started_at = '2026-09-19T10:00:00.000Z' WHERE id = ?").run(s2.id);

  withMode('weekly', () => {
    const result = assignWaves(db);
    assert.ok(result.updated >= 1);
    assert.equal(getSubscription(db, s1.id).wave, 1);
    assert.equal(getSubscription(db, s2.id).wave, 3);
  });
});
