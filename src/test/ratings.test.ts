import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomer, seedProduct, testDb } from './helpers.ts';
import { createEdition, lockEdition, setEditionItem } from '../services/editions.ts';
import { createOrder, markDelivered, pack, ship, startPicking } from '../services/orders.ts';
import { getCustomerEditionRatings, listCustomerRatings, upsertEditionFeedback, upsertProductRating } from '../services/ratings.ts';
import { editionReport, editionReportCsv } from '../services/reports.ts';
import { createRetailer, recordClick, recordConversion, setRetailerLink } from '../services/retailers.ts';
import { createSupplier } from '../services/suppliers.ts';
import { updateProduct } from '../services/products.ts';
import { AppError } from '../domain/errors.ts';

function shippedBox(db: ReturnType<typeof testDb>) {
  const supplier = createSupplier(db, { name: 'Testleverantören AB', contactEmail: 'kontakt@example.com' });
  const products = ['A', 'B', 'C', 'D'].map((code) => seedProduct(db, code, 50));
  for (const p of products) updateProduct(db, p.id, { supplierId: supplier.id });
  const edition = createEdition(db, { period: '2026-10' });
  for (const p of products) setEditionItem(db, edition.id, p.id, 1);
  lockEdition(db, edition.id);

  const customer = seedCustomer(db);
  const order = createOrder(db, {
    customerId: customer.id,
    lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }],
    editionId: edition.id,
    paymentStatus: 'paid',
  });
  startPicking(db, order.id);
  pack(db, order.id);
  ship(db, order.id, { carrier: 'postnord', trackingNumber: 'PN-1' });
  markDelivered(db, order.id);
  return { db, edition, products, customer, supplier };
}

test('betyg kopplas till både kund och månadens box', () => {
  const { db, edition, products, customer } = shippedBox(testDb());
  const rating = upsertProductRating(db, {
    customerId: customer.id, editionId: edition.id, productId: products[0]!.id,
    rating: 5, sentiment: 'like', wouldBuyAgain: true, comment: 'Riktigt bra',
  });
  assert.equal(rating.rating, 5);
  assert.equal(rating.wouldBuyAgain, true);

  // Samma anrop igen uppdaterar i stället för att skapa ett nytt betyg.
  upsertProductRating(db, { customerId: customer.id, editionId: edition.id, productId: products[0]!.id, rating: 3, sentiment: 'neutral' });
  const view = getCustomerEditionRatings(db, customer.id, edition.id);
  assert.equal(view.ratings.length, 1);
  assert.equal(view.ratings[0]?.rating, 3);
  assert.equal(view.received, true);

  const history = listCustomerRatings(db, customer.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.period, '2026-10');
});

test('bara kunder som fått boxen kan betygsätta den', () => {
  const { db, edition, products } = shippedBox(testDb());
  const outsider = seedCustomer(db, { email: 'utan@example.com' });
  assert.throws(
    () => upsertProductRating(db, { customerId: outsider.id, editionId: edition.id, productId: products[0]!.id, rating: 5 }),
    (e: unknown) => e instanceof AppError && e.code === 'BOX_NOT_RECEIVED',
  );
});

test('produkter utanför boxen kan inte betygsättas', () => {
  const { db, edition, customer } = shippedBox(testDb());
  const other = seedProduct(db, 'UTANFOR', 10);
  assert.throws(
    () => upsertProductRating(db, { customerId: customer.id, editionId: edition.id, productId: other.id, rating: 5 }),
    (e: unknown) => e instanceof AppError && e.code === 'PRODUCT_NOT_IN_BOX',
  );
});

test('tomt betyg avvisas', () => {
  const { db, edition, products, customer } = shippedBox(testDb());
  assert.throws(
    () => upsertProductRating(db, { customerId: customer.id, editionId: edition.id, productId: products[0]!.id }),
    (e: unknown) => e instanceof AppError && e.code === 'EMPTY_RATING',
  );
});

test('rapporten summerar betyg och merköp per produkt', () => {
  const { db, edition, products, customer, supplier } = shippedBox(testDb());
  const second = seedCustomer(db, { email: 'tva@example.com' });
  const order = createOrder(db, {
    customerId: second.id, lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }], editionId: edition.id, paymentStatus: 'paid',
  });
  startPicking(db, order.id);
  pack(db, order.id);
  ship(db, order.id, { carrier: 'dhl' });

  upsertProductRating(db, { customerId: customer.id, editionId: edition.id, productId: products[0]!.id, rating: 5, sentiment: 'like', wouldBuyAgain: true, comment: 'Toppen' });
  upsertProductRating(db, { customerId: second.id, editionId: edition.id, productId: products[0]!.id, rating: 3, sentiment: 'dislike', wouldBuyAgain: false });
  upsertEditionFeedback(db, { customerId: customer.id, editionId: edition.id, rating: 4 });

  const retailer = createRetailer(db, { name: 'Butiken' });
  const link = setRetailerLink(db, { retailerId: retailer.id, productId: products[0]!.id, url: 'https://exempel.se/a' });
  const click = recordClick(db, link.id, { customerId: customer.id, period: '2026-10' });
  recordClick(db, link.id, { customerId: second.id, period: '2026-10' });
  recordConversion(db, click.conversionRef, { valueOre: 12_000 });

  const report = editionReport(db, edition.id, { includeComments: true });
  assert.equal(report.boxesShipped, 2);
  assert.equal(report.ratedCustomers, 2);
  assert.equal(report.boxRating.average, 4);

  const row = report.products.find((p) => p.productId === products[0]!.id)!;
  assert.equal(row.responses, 2);
  assert.equal(row.averageRating, 4);
  assert.equal(row.likes, 1);
  assert.equal(row.dislikes, 1);
  assert.equal(row.likeSharePercent, 50);
  assert.equal(row.wouldBuyAgain, 1);
  assert.equal(row.cansShipped, 2);
  assert.equal(row.clicks, 2);
  assert.equal(row.clickCustomers, 2);
  assert.equal(row.conversions, 1);
  assert.equal(row.conversionValueOre, 12_000);
  assert.equal(row.comments.length, 1);
  assert.equal(row.supplierName, 'Testleverantören AB');

  // Filtrerad rapport till en leverantör innehåller bara deras produkter.
  const otherSupplier = createSupplier(db, { name: 'Annan leverantör' });
  assert.equal(editionReport(db, edition.id, { supplierId: otherSupplier.id }).products.length, 0);
  assert.equal(editionReport(db, edition.id, { supplierId: supplier.id }).products.length, 4);

  const csv = editionReportCsv(db, edition.id, { supplierId: supplier.id });
  assert.match(csv, /Snittbetyg/);
  assert.match(csv, /Testleverantören AB/);
  assert.equal(csv.split('\n').filter(Boolean).length, 5, 'rubrik + fyra produkter');
});
