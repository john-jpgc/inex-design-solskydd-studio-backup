import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.ts';
import { createApp } from '../http/app.ts';
import { config } from '../config.ts';
import { seedAdmin, seedProducts } from '../db/seed.ts';

config.apiKey = 'test-api-key';
const HEADERS = { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' };

function setup() {
  const db = testDb();
  process.env.ADMIN_PASSWORD = 'hemligt123';
  seedAdmin(db);
  seedProducts(db);
  return createApp(db);
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });

test('API kräver nyckel', async () => {
  const app = setup();
  const res = await app.request('/api/v1/orders');
  assert.equal(res.status, 401);
  const ok = await app.request('/api/v1/orders', { headers: { 'X-API-Key': 'test-api-key' } });
  assert.equal(ok.status, 200);
});

test('order kan skapas och drivas genom hela flödet via API', async () => {
  const app = setup();
  const created = await post(app, '/api/v1/orders', {
    customer: { email: 'api@example.com', firstName: 'Api', lastName: 'Testsson', birthDate: '1990-01-01' },
    shippingAddress: { street: 'Testgatan 1', postalCode: '111 22', city: 'Stockholm' },
    lines: [
      { kind: 'mystery_box', boxSize: 4, quantity: 1 },
      { kind: 'product', sku: 'ZYN-COOL-MINT-S', quantity: 2 },
    ],
    paymentStatus: 'paid',
    paymentMethod: 'swish',
    externalRef: 'SHOP-42',
  });
  assert.equal(created.status, 201);
  const { order } = (await created.json()) as { order: { id: number; orderNumber: string; status: string } };
  assert.equal(order.status, 'paid');

  const dup = await post(app, '/api/v1/orders', {
    customer: { email: 'api@example.com', firstName: 'Api', lastName: 'Testsson', birthDate: '1990-01-01' },
    shippingAddress: { street: 'Testgatan 1', postalCode: '11122', city: 'Stockholm' },
    lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }],
    externalRef: 'SHOP-42',
  });
  assert.equal(dup.status, 409);

  assert.equal((await post(app, `/api/v1/orders/${order.id}/pick`, {})).status, 200);
  assert.equal((await post(app, `/api/v1/orders/${order.id}/pack`, {})).status, 200);
  const shipped = await post(app, `/api/v1/orders/${order.id}/ship`, { carrier: 'postnord', trackingNumber: 'PN-1' });
  assert.equal(shipped.status, 200);

  const webhook = await post(app, '/api/v1/shipments/tracking/PN-1/events', { status: 'delivered', location: 'Stockholm' });
  assert.equal(webhook.status, 200);

  const byNumber = await app.request(`/api/v1/orders/number/${order.orderNumber}`, { headers: HEADERS });
  const { order: final } = (await byNumber.json()) as { order: { status: string; shipments: { status: string }[] } };
  assert.equal(final.status, 'delivered');
  assert.equal(final.shipments[0]?.status, 'delivered');
});

test('valideringsfel ger 400 med detaljer', async () => {
  const app = setup();
  const res = await post(app, '/api/v1/customers', { email: 'inte-en-epost', firstName: '', lastName: 'X', birthDate: '1990' });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string; details: { fieldErrors: Record<string, string[]> } } };
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.fieldErrors.email);
  assert.ok(body.error.details.fieldErrors.birthDate);
});

test('lagerjustering och lågt lager via API', async () => {
  const app = setup();
  const low = await app.request('/api/v1/products?lowStock=true', { headers: HEADERS });
  const { products } = (await low.json()) as { products: { id: number; sku: string; stockAvailable: number }[] };
  assert.ok(products.some((p) => p.sku === 'ACE-COOL-MINT-X'));
  const ace = products.find((p) => p.sku === 'ACE-COOL-MINT-X')!;
  const adjusted = await post(app, `/api/v1/products/${ace.id}/stock`, { delta: 50, reason: 'purchase', note: 'Leverans' });
  assert.equal(adjusted.status, 200);
  const { product } = (await adjusted.json()) as { product: { stockAvailable: number } };
  assert.equal(product.stockAvailable, ace.stockAvailable + 50);
});

test('admin kräver inloggning och inloggning ger session', async () => {
  const app = setup();
  const anon = await app.request('/admin/orders');
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location') ?? '', /\/admin\/login/);

  const bad = await app.request('/admin/login', { method: 'POST', body: new URLSearchParams({ email: 'admin@mysterysnus.se', password: 'fel' }) });
  assert.equal(bad.status, 401);

  const login = await app.request('/admin/login', { method: 'POST', body: new URLSearchParams({ email: 'admin@mysterysnus.se', password: 'hemligt123' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.match(cookie, /ms_session=/);

  const dash = await app.request('/admin', { headers: { cookie: cookie.split(';')[0]! } });
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /Översikt/);
});
