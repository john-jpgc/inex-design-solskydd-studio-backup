import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomer, seedProduct, testDb } from './helpers.ts';
import { createEdition, editionForecast, getEdition, lockEdition, setEditionItem, unlockEdition } from '../services/editions.ts';
import { createOrder, getOrder, pack, startPicking } from '../services/orders.ts';
import { createSubscription, renewSubscription } from '../services/subscriptions.ts';
import { getProduct } from '../services/products.ts';
import { AppError } from '../domain/errors.ts';

function boxOfFour(db: ReturnType<typeof testDb>, period = '2026-10') {
  const a = seedProduct(db, 'A', 50, { brand: 'Velo', flavor: 'mint' });
  const b = seedProduct(db, 'B', 50, { brand: 'Zyn', flavor: 'citrus' });
  const c = seedProduct(db, 'C', 50, { brand: 'Loop', flavor: 'lakrits' });
  const d = seedProduct(db, 'D', 50, { brand: 'Killa', flavor: 'bär' });
  const edition = createEdition(db, { period });
  for (const p of [a, b, c, d]) setEditionItem(db, edition.id, p.id, 1);
  return { edition: getEdition(db, edition.id), products: [a, b, c, d] };
}

test('en box måste innehålla exakt fyra dosor för att kunna låsas', () => {
  const db = testDb();
  const a = seedProduct(db, 'A', 10);
  const edition = createEdition(db, { period: '2026-10' });
  setEditionItem(db, edition.id, a.id, 3);
  assert.throws(() => lockEdition(db, edition.id), (e: unknown) => e instanceof AppError && e.code === 'WRONG_BOX_SIZE');
  setEditionItem(db, edition.id, a.id, 4);
  assert.equal(lockEdition(db, edition.id).status, 'locked');
});

test('låst box kan inte ändras', () => {
  const db = testDb();
  const { edition, products } = boxOfFour(db);
  lockEdition(db, edition.id);
  assert.throws(
    () => setEditionItem(db, edition.id, products[0]!.id, 2),
    (e: unknown) => e instanceof AppError && e.code === 'EDITION_LOCKED',
  );
  assert.equal(unlockEdition(db, edition.id).status, 'draft');
});

test('alla kunder får exakt samma innehåll ur månadens box', () => {
  const db = testDb();
  const { edition, products } = boxOfFour(db);
  lockEdition(db, edition.id);

  const orders = ['a@example.com', 'b@example.com', 'c@example.com'].map((email) => {
    const customer = seedCustomer(db, { email, prefStrength: 'mild', excludedFlavors: ['mint'] });
    const order = createOrder(db, {
      customerId: customer.id,
      lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }],
      editionId: edition.id,
      paymentStatus: 'paid',
    });
    return startPicking(db, order.id, 'test');
  });

  const contents = orders.map((o) =>
    o.lines[0]!.picks.map((p) => `${p.productId}x${p.quantity}`).sort().join(','),
  );
  assert.equal(new Set(contents).size, 1, 'alla boxar ska ha samma innehåll');
  assert.equal(contents[0], products.map((p) => `${p.id}x1`).sort().join(','));
  assert.ok(
    orders[0]!.lines[0]!.picks.some((p) => p.flavor === 'mint'),
    'kundens uteslutna smak styr inte längre innehållet i en kuraterad box',
  );
});

test('boxen måste vara låst innan plockning startar', () => {
  const db = testDb();
  const { edition } = boxOfFour(db);
  const customer = seedCustomer(db);
  const order = createOrder(db, {
    customerId: customer.id,
    lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }],
    editionId: edition.id,
    paymentStatus: 'paid',
  });
  assert.throws(() => startPicking(db, order.id), (e: unknown) => e instanceof AppError && e.code === 'EDITION_NOT_LOCKED');
});

test('prenumerationsorder kopplas automatiskt till periodens box och drar rätt lager', () => {
  const db = testDb();
  const { edition, products } = boxOfFour(db, '2026-10');
  lockEdition(db, edition.id);
  const customer = seedCustomer(db);
  const sub = createSubscription(db, { customerId: customer.id, startAt: '2026-10-01T06:00:00.000Z' });

  const renewed = renewSubscription(db, sub.id, { paymentStatus: 'paid' });
  assert.equal(renewed.order.editionId, edition.id);
  startPicking(db, renewed.order.id);
  pack(db, renewed.order.id);
  for (const p of products) assert.equal(getProduct(db, p.id).stockOnHand, 49, `${p.sku} ska ha dragits med 1`);
  assert.equal(getOrder(db, renewed.order.id).status, 'packed');
});

test('prognosen visar behov och brist för alla prenumeranter', () => {
  const db = testDb();
  const a = seedProduct(db, 'A', 5);
  const b = seedProduct(db, 'B', 100);
  const edition = createEdition(db, { period: '2026-10' });
  setEditionItem(db, edition.id, a.id, 2);
  setEditionItem(db, edition.id, b.id, 2);
  for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
    createSubscription(db, { customerId: seedCustomer(db, { email }).id });
  }

  const forecast = editionForecast(db, edition.id);
  assert.equal(forecast.boxesNeeded, 4);
  const rowA = forecast.rows.find((r) => r.sku === 'A')!;
  assert.equal(rowA.needed, 8);
  assert.equal(rowA.available, 5);
  assert.equal(rowA.shortfall, 3);
  assert.equal(forecast.rows.find((r) => r.sku === 'B')!.shortfall, 0);
  assert.equal(forecast.totalShortfall, 3);
});

test('webbshopen behöver inte känna till boxen – periodens utgåva binds automatiskt', () => {
  const db = testDb();
  const period = new Date().toISOString().slice(0, 7);
  const { edition, products } = boxOfFour(db, period);
  lockEdition(db, edition.id);
  const customer = seedCustomer(db);

  // Ingen editionId skickas, och en felaktig boxstorlek rättas av utgåvan.
  const order = createOrder(db, {
    customerId: customer.id,
    lines: [{ kind: 'mystery_box', boxSize: 1, quantity: 1 }],
    paymentStatus: 'paid',
  });
  assert.equal(order.editionId, edition.id);
  assert.equal(order.lines[0]?.boxSize, 4, 'utgåvan bestämmer antalet dosor');
  assert.match(order.lines[0]?.description ?? '', /^Mysterysnus/);

  const picked = startPicking(db, order.id);
  assert.equal(picked.lines[0]!.picks.length, products.length);
  assert.doesNotThrow(() => pack(db, order.id));
});

test('editionId null ger en fristående box utanför prenumerationen', () => {
  const db = testDb();
  const period = new Date().toISOString().slice(0, 7);
  const { edition } = boxOfFour(db, period);
  lockEdition(db, edition.id);
  const customer = seedCustomer(db);

  const order = createOrder(db, {
    customerId: customer.id,
    lines: [{ kind: 'mystery_box', boxSize: 2, quantity: 1, unitPriceOre: 14_900 }],
    editionId: null,
    paymentStatus: 'paid',
  });
  assert.equal(order.editionId, null);
  assert.equal(order.lines[0]?.boxSize, 2);
  const picked = startPicking(db, order.id);
  assert.equal(picked.lines[0]!.picks.reduce((s, p) => s + p.quantity, 0), 2);
});
