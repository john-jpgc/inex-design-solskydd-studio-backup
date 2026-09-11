import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomer, seedProduct, testDb } from './helpers.ts';
import { createOrder, getOrder, pack, ship, startPicking } from '../services/orders.ts';
import { createLabelForShipment, getStoredLabel } from '../services/labels.ts';
import { setLabelProvider, type LabelProvider, type LabelRequest } from '../logistics/index.ts';
import { config } from '../config.ts';
import { AppError } from '../domain/errors.ts';

class FakeProvider implements LabelProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly carriers = ['postnord'] as const;
  requests: LabelRequest[] = [];
  isConfigured() { return true; }
  async createLabel(req: LabelRequest) {
    this.requests.push(req);
    return { trackingNumber: 'FAKE-123', providerRef: 'booking-1', label: { format: 'pdf' as const, data: new TextEncoder().encode('%PDF-fake') } };
  }
}

function shippedOrder(db: ReturnType<typeof testDb>, carrier: 'postnord' | 'dhl' = 'postnord') {
  const customer = seedCustomer(db);
  seedProduct(db, 'A', 10);
  const order = createOrder(db, { customerId: customer.id, lines: [{ kind: 'product', sku: 'A', quantity: 1 }], paymentStatus: 'paid' });
  startPicking(db, order.id);
  pack(db, order.id);
  return ship(db, order.id, { carrier });
}

test('etikett bokas via leverantören och sparas på försändelsen', async () => {
  const db = testDb();
  const fake = new FakeProvider();
  setLabelProvider(fake);
  Object.assign(config.sender, { street: 'Lagergatan 1', postalCode: '12345', city: 'Stockholm' });
  try {
    const order = shippedOrder(db);
    const shipment = order.shipments[0]!;
    assert.equal(shipment.status, 'created', 'utan kollinummer är försändelsen bara skapad');

    const updated = await createLabelForShipment(db, shipment.id, 'test');
    assert.equal(updated.trackingNumber, 'FAKE-123');
    assert.equal(updated.status, 'label_printed');
    assert.equal(updated.labelProvider, 'fake');
    assert.equal(updated.labelRef, 'booking-1');
    assert.match(updated.trackingUrl ?? '', /postnord/);
    assert.equal(fake.requests[0]?.recipient.name, order.shipName);
    assert.equal(fake.requests[0]?.sender.street, 'Lagergatan 1');
    assert.equal(fake.requests[0]?.weightGrams, shipment.weightGrams);

    const label = getStoredLabel(db, shipment.id);
    assert.equal(label.format, 'pdf');
    assert.equal(new TextDecoder().decode(label.data), '%PDF-fake');
    assert.ok(getOrder(db, order.id).events.some((e) => e.type === 'label'));

    await assert.rejects(() => createLabelForShipment(db, shipment.id), (e: unknown) => e instanceof AppError && e.code === 'LABEL_EXISTS');
  } finally {
    setLabelProvider(undefined);
  }
});

test('leverantör som inte stödjer transportören avvisas', async () => {
  const db = testDb();
  setLabelProvider(new FakeProvider());
  try {
    const order = shippedOrder(db, 'dhl');
    await assert.rejects(() => createLabelForShipment(db, order.shipments[0]!.id), (e: unknown) => e instanceof AppError && e.code === 'UNSUPPORTED_CARRIER');
  } finally {
    setLabelProvider(undefined);
  }
});

test('manuellt läge ger tydligt fel', async () => {
  const db = testDb();
  const order = shippedOrder(db);
  await assert.rejects(() => createLabelForShipment(db, order.shipments[0]!.id), (e: unknown) => e instanceof AppError && e.code === 'LABEL_PROVIDER_NOT_CONFIGURED');
});
