import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomer, seedProduct, testDb } from './helpers.ts';
import { clickStats, createRetailer, listLinksForProduct, recordClick, recordConversion, setRetailerLink } from '../services/retailers.ts';
import { createApp } from '../http/app.ts';
import { AppError } from '../domain/errors.ts';

test('klick loggas med kund och period och får en unik köpreferens', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const product = seedProduct(db, 'A', 10);
  const retailer = createRetailer(db, { name: 'Butiken', website: 'https://exempel.se' });
  const link = setRetailerLink(db, { retailerId: retailer.id, productId: product.id, url: 'https://exempel.se/produkt?kampanj=host' });

  const click = recordClick(db, link.id, { customerToken: customer.publicToken, source: 'profil' });
  assert.match(click.redirectUrl, /^https:\/\/exempel\.se\/produkt\?/);
  assert.match(click.redirectUrl, /kampanj=host/, 'befintliga parametrar behålls');
  assert.match(click.redirectUrl, /ref=MSR-/, 'spårningsreferens läggs till');

  const rows = db.prepare('SELECT customer_id, product_id, source FROM retailer_clicks WHERE id = ?').get(click.clickId) as Record<string, unknown>;
  assert.equal(rows.customer_id, customer.id);
  assert.equal(rows.product_id, product.id);
  assert.equal(rows.source, 'profil');
});

test('okänd kundtoken loggas anonymt i stället för att fela', () => {
  const db = testDb();
  const product = seedProduct(db, 'A', 10);
  const retailer = createRetailer(db, { name: 'Butiken' });
  const link = setRetailerLink(db, { retailerId: retailer.id, productId: product.id, url: 'https://exempel.se/p' });
  const click = recordClick(db, link.id, { customerToken: 'finns-inte' });
  const row = db.prepare('SELECT customer_id FROM retailer_clicks WHERE id = ?').get(click.clickId) as { customer_id: number | null };
  assert.equal(row.customer_id, null);
});

test('återförsäljaren rapporterar köp via referensen, upprepade rapporter räknas en gång', () => {
  const db = testDb();
  const product = seedProduct(db, 'A', 10);
  const retailer = createRetailer(db, { name: 'Butiken' });
  const link = setRetailerLink(db, { retailerId: retailer.id, productId: product.id, url: 'https://exempel.se/p' });
  const click = recordClick(db, link.id, {});

  recordConversion(db, click.conversionRef, { valueOre: 9_900 });
  recordConversion(db, click.conversionRef, { valueOre: 50_000 });
  const stats = clickStats(db, { productId: product.id });
  assert.equal(stats[0]?.conversions, 1);
  assert.equal(stats[0]?.conversionValueOre, 9_900);

  assert.throws(() => recordConversion(db, 'MSR-finns-inte'), (e: unknown) => e instanceof AppError && e.status === 404);
});

test('ogiltig adress avvisas när länken sparas', () => {
  const db = testDb();
  const product = seedProduct(db, 'A', 10);
  const retailer = createRetailer(db, { name: 'Butiken' });
  assert.throws(
    () => setRetailerLink(db, { retailerId: retailer.id, productId: product.id, url: 'butiken.se/produkt' }),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_URL',
  );
});

test('den publika länken loggar klicket och skickar kunden vidare utan inloggning', async () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const product = seedProduct(db, 'A', 10);
  const retailer = createRetailer(db, { name: 'Butiken' });
  const link = setRetailerLink(db, { retailerId: retailer.id, productId: product.id, url: 'https://exempel.se/p' });
  const app = createApp(db);

  const res = await app.request(`/r/${link.id}?t=${customer.publicToken}&s=profil`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^https:\/\/exempel\.se\/p\?ref=MSR-/);

  const count = db.prepare('SELECT COUNT(*) AS n FROM retailer_clicks WHERE customer_id = ?').get(customer.id) as { n: number };
  assert.equal(count.n, 1);

  const missing = await app.request('/r/999999');
  assert.equal(missing.status, 404);
});

test('köplänkar för en produkt får färdiga spårningsadresser', () => {
  const db = testDb();
  const customer = seedCustomer(db);
  const product = seedProduct(db, 'A', 10);
  const r1 = createRetailer(db, { name: 'Butik ett' });
  const r2 = createRetailer(db, { name: 'Butik två' });
  setRetailerLink(db, { retailerId: r1.id, productId: product.id, url: 'https://ett.example/p', priceOre: 4_200 });
  setRetailerLink(db, { retailerId: r2.id, productId: product.id, url: 'https://tva.example/p' });

  const links = listLinksForProduct(db, product.id, { customerToken: customer.publicToken, period: '2026-10' });
  assert.equal(links.length, 2);
  assert.match(links[0]!.trackingUrl, new RegExp(`/r/${links[0]!.id}\\?t=${customer.publicToken}&p=2026-10`));
  assert.equal(links[0]!.priceOre, 4_200);
});
