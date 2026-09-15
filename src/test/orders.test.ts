import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomer, seedProduct, testDb } from './helpers.ts';
import {
  cancelOrder,
  createOrder,
  getOrder,
  markDelivered,
  markPaid,
  markReturned,
  pack,
  setBoxPicks,
  ship,
  startPicking,
} from '../services/orders.ts';
import { getProduct } from '../services/products.ts';
import { addShipmentEvent, findShipmentByTracking } from '../services/shipments.ts';
import { AppError } from '../domain/errors.ts';

test('fullständigt orderflöde: skapa → betala → plocka → packa → skicka → leverera', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const p1 = seedProduct(db, 'VELO-MINT', 20, { brand: 'Velo', flavor: 'mint', priceOre: 4_900 });
  const p2 = seedProduct(db, 'ZYN-CITRUS', 20, { brand: 'Zyn', flavor: 'citrus', strength: 'medium' });
  seedProduct(db, 'LOOP-LAKRITS', 20, { brand: 'Loop', flavor: 'lakrits' });

  const order = createOrder(db, {
    customerId: customer.id,
    lines: [
      { kind: 'product', sku: 'VELO-MINT', quantity: 2 },
      { kind: 'mystery_box', boxSize: 4, quantity: 1 },
    ],
    paymentMethod: 'swish',
  });

  assert.equal(order.orderNumber, 'MS-000001');
  assert.equal(order.status, 'pending');
  assert.equal(order.subtotalOre, 2 * 4_900 + 24_900);
  assert.equal(order.shippingOre, 4_900, 'under fri frakt-gränsen');
  assert.equal(order.totalOre, order.subtotalOre + 4_900);
  assert.equal(order.vatOre, Math.round((order.totalOre * 0.2)));
  assert.equal(getProduct(db, p1.id).stockReserved, 2, 'produktrad reserveras direkt');

  const paid = markPaid(db, order.id, { paymentRef: 'SWISH-123' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paymentStatus, 'paid');

  const picking = startPicking(db, order.id, 'test');
  assert.equal(picking.status, 'picking');
  const box = picking.lines.find((l) => l.kind === 'mystery_box')!;
  assert.equal(box.picks.reduce((s, p) => s + p.quantity, 0), 4, 'boxen får 4 dosor föreslagna');

  const packed = pack(db, order.id, 'test');
  assert.equal(packed.status, 'packed');
  assert.equal(getProduct(db, p1.id).stockReserved, 0);
  const totalOnHand = [p1, p2].reduce((s, p) => s + getProduct(db, p.id).stockOnHand, 0) + getProduct(db, 3).stockOnHand;
  assert.equal(totalOnHand, 60 - 2 - 4, 'lagret dras vid packning');

  const shipped = ship(db, order.id, { carrier: 'postnord', trackingNumber: 'PN123' }, 'test');
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.shipments.length, 1);
  assert.match(shipped.shipments[0]!.trackingUrl ?? '', /postnord/);
  assert.ok((shipped.shipments[0]!.weightGrams ?? 0) > 60, 'vikt uppskattas');

  const found = findShipmentByTracking(db, 'PN123')!;
  addShipmentEvent(db, found.id, { status: 'delivered', location: 'Stockholm' });
  const delivered = getOrder(db, order.id);
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.deliveredAt);
  assert.equal(delivered.shipments[0]!.status, 'delivered');
});

test('spårningshändelse "delivered" levererar ordern automatiskt', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  seedProduct(db, 'A', 10);
  const order = createOrder(db, { customerId: customer.id, lines: [{ kind: 'product', sku: 'A', quantity: 1 }], paymentStatus: 'paid' });
  startPicking(db, order.id);
  pack(db, order.id);
  const shipped = ship(db, order.id, { carrier: 'budbee', trackingNumber: 'BB1' });
  const result = addShipmentEvent(db, shipped.shipments[0]!.id, { status: 'delivered' });
  assert.equal(result.status, 'delivered');
  assert.throws(() => markDelivered(db, order.id), /kan inte gå till/);
});

test('minderåriga kan inte beställa', () => {
  const db = testDb();
  const year = new Date().getUTCFullYear() - 17;
  const kid = seedCustomer(db, { email: 'ung@example.com', birthDate: `${year}-01-01` });
  seedProduct(db, 'A', 10);
  assert.throws(
    () => createOrder(db, { customerId: kid.id, lines: [{ kind: 'product', sku: 'A', quantity: 1 }] }),
    (err: unknown) => err instanceof AppError && err.code === 'UNDERAGE',
  );
});

test('order avvisas om lagret inte räcker', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  seedProduct(db, 'A', 1);
  assert.throws(
    () => createOrder(db, { customerId: customer.id, lines: [{ kind: 'product', sku: 'A', quantity: 2 }] }),
    (err: unknown) => err instanceof AppError && err.code === 'INSUFFICIENT_STOCK',
  );
});

test('avbruten order släpper reservationen', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const p = seedProduct(db, 'A', 5);
  const order = createOrder(db, { customerId: customer.id, lines: [{ kind: 'product', sku: 'A', quantity: 3 }], paymentStatus: 'paid' });
  assert.equal(getProduct(db, p.id).stockReserved, 3);
  const cancelled = cancelOrder(db, order.id, 'Kunden ångrade sig');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.paymentStatus, 'refund_due');
  assert.equal(getProduct(db, p.id).stockReserved, 0);
  assert.equal(getProduct(db, p.id).stockOnHand, 5);
});

test('packning stoppas om boxen är ofullständig och manuell justering fungerar', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const p = seedProduct(db, 'A', 2);
  const order = createOrder(db, { customerId: customer.id, lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }], paymentStatus: 'paid' });
  const picking = startPicking(db, order.id);
  assert.ok(picking.events.some((e) => e.type === 'warning'), 'varnar om lagerbrist');
  assert.throws(() => pack(db, order.id), (err: unknown) => err instanceof AppError && err.code === 'BOX_INCOMPLETE');

  seedProduct(db, 'B', 10);
  const line = picking.lines[0]!;
  const adjusted = setBoxPicks(db, order.id, line.id, [
    { productId: p.id, quantity: 2 },
    { productId: 2, quantity: 2 },
  ]);
  assert.equal(adjusted.lines[0]!.picks.reduce((s, x) => s + x.quantity, 0), 4);
  const packed = pack(db, order.id);
  assert.equal(packed.status, 'packed');
  assert.equal(getProduct(db, p.id).stockOnHand, 0);
  assert.equal(getProduct(db, 2).stockOnHand, 8);
});

test('retur med återföring lägger tillbaka lagret', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const p = seedProduct(db, 'A', 5);
  const order = createOrder(db, { customerId: customer.id, lines: [{ kind: 'product', sku: 'A', quantity: 2 }], paymentStatus: 'paid' });
  startPicking(db, order.id);
  pack(db, order.id);
  ship(db, order.id, { carrier: 'dhl' });
  assert.equal(getProduct(db, p.id).stockOnHand, 3);
  const returned = markReturned(db, order.id, { restock: true, reason: 'Ej uthämtad' });
  assert.equal(returned.status, 'returned');
  assert.equal(getProduct(db, p.id).stockOnHand, 5);
});

test('fri frakt över gränsen och dubblettskydd på externa referenser', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  seedProduct(db, 'A', 100, { priceOre: 10_000 });
  const order = createOrder(db, {
    customerId: customer.id,
    lines: [{ kind: 'product', sku: 'A', quantity: 5 }],
    externalRef: 'SHOP-1',
  });
  assert.equal(order.shippingOre, 0);
  assert.throws(
    () => createOrder(db, { customerId: customer.id, lines: [{ kind: 'product', sku: 'A', quantity: 1 }], externalRef: 'SHOP-1' }),
    (err: unknown) => err instanceof AppError && err.code === 'DUPLICATE_ORDER',
  );
});

test('kund kan skapas inline via e-post', () => {
  const db = testDb();
  seedProduct(db, 'A', 10);
  const order = createOrder(db, {
    customer: { email: 'ny@example.com', firstName: 'Nils', lastName: 'Nilsson', birthDate: '1985-02-02' },
    shippingAddress: { street: 'Vägen 2', postalCode: '123 45', city: 'Göteborg' },
    lines: [{ kind: 'product', sku: 'A', quantity: 1 }],
  });
  assert.equal(order.customer.email, 'ny@example.com');
  assert.equal(order.shipPostalCode, '12345');
  assert.equal(order.shipName, 'Nils Nilsson');
});
