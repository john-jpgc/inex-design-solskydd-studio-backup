/**
 * Fyller databasen med ett admin-konto och – utanför produktion – exempeldata
 * (produkter, kunder och ordrar i olika statusar). Kan köras flera gånger.
 */
import { pathToFileURL } from 'node:url';
import { config, isProduction } from '../config.ts';
import { migrate, openDatabase, type Db } from './connection.ts';
import { createStaffUser, listStaff } from '../services/auth.ts';
import { createProduct, findProductBySku, listProducts, updateProduct } from '../services/products.ts';
import { adjustStock } from '../services/inventory.ts';
import { createCustomer, countCustomers } from '../services/customers.ts';
import { markPaid, pack, ship, startPicking, markDelivered } from '../services/orders.ts';
import type { Strength } from '../domain/products.ts';
import { createSubscription, pauseSubscription, renewSubscription } from '../services/subscriptions.ts';
import { createEdition, lockEdition, periodLabel, setEditionItem } from '../services/editions.ts';
import { upsertSupplierByName } from '../services/suppliers.ts';
import { createRetailer, recordClick, recordConversion, setRetailerLink } from '../services/retailers.ts';
import { upsertEditionFeedback, upsertProductRating } from '../services/ratings.ts';

export const DEV_ADMIN_PASSWORD = 'admin123';

/** Skapar admin-kontot om ingen personal finns. Returnerar e-posten om ett konto skapades. */
export function seedAdmin(db: Db): string | null {
  if (listStaff(db).length > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@mysterysnus.se';
  const password = process.env.ADMIN_PASSWORD || (isProduction() ? '' : DEV_ADMIN_PASSWORD);
  if (!password) throw new Error('ADMIN_PASSWORD måste sättas för att skapa admin-kontot i produktion');
  createStaffUser(db, { email, name: 'Admin', role: 'admin', password });
  return email;
}

type SeedProduct = [sku: string, brand: string, name: string, flavor: string, strength: Strength, mg: number, priceKr: number, stock: number];

const PRODUCTS: SeedProduct[] = [
  ['VELO-ICE-COOL-S', 'VELO', 'Ice Cool Strong', 'mint', 'strong', 10, 49, 120],
  ['VELO-FREEZE-XS', 'VELO', 'Freeze X-Strong', 'mint', 'extra_strong', 14, 49, 80],
  ['VELO-TROPIC', 'VELO', 'Tropic Breeze', 'tropisk frukt', 'medium', 6, 45, 60],
  ['VELO-RUBY', 'VELO', 'Ruby Berry', 'bär', 'mild', 4, 45, 40],
  ['ZYN-COOL-MINT-S', 'ZYN', 'Cool Mint Strong', 'mint', 'strong', 9, 47, 150],
  ['ZYN-CITRUS-MINI', 'ZYN', 'Citrus Mini', 'citrus', 'mild', 3, 42, 70],
  ['ZYN-ESPRESSINO', 'ZYN', 'Espressino Strong', 'kaffe', 'strong', 9, 47, 55],
  ['ZYN-BELLINI', 'ZYN', 'Bellini', 'persika', 'medium', 6, 45, 45],
  ['LOOP-JALAPENO', 'LOOP', 'Jalapeño Lime Strong', 'lime', 'strong', 9, 49, 65],
  ['LOOP-MINT-MANIA', 'LOOP', 'Mint Mania X-Strong', 'mint', 'extra_strong', 15, 49, 90],
  ['LOOP-LINGON', 'LOOP', 'Salty Ligonberry', 'lingon', 'medium', 6, 45, 30],
  ['NS-BERGAMOT', 'Nordic Spirit', 'Bergamot Wildberry', 'bär', 'medium', 6, 46, 50],
  ['NS-ELDERFLOWER', 'Nordic Spirit', 'Elderflower', 'fläder', 'mild', 4, 46, 35],
  ['KILLA-COLD-MINT', 'Killa', 'Cold Mint', 'mint', 'extra_strong', 16, 55, 100],
  ['PABLO-ICE-COLD', 'Pablo', 'Ice Cold', 'mint', 'extra_strong', 30, 59, 75],
  ['SKRUF-SW-FRESH4', 'Skruf', 'Super White Fresh #4', 'mint', 'strong', 11, 48, 60],
  ['XQS-BLUEBERRY', 'XQS', 'Blueberry Mint', 'blåbär', 'medium', 8, 47, 40],
  ['ACE-COOL-MINT-X', 'ACE', 'Cool Mint Extreme', 'mint', 'extra_strong', 18, 49, 8],
  ['KLINT-ARCTIC', 'Klint', 'Arctic Mint', 'mint', 'strong', 10, 46, 25],
  ['LYFT-LAKRITS', 'LYFT', 'Lakrits', 'lakrits', 'medium', 8, 45, 0],
];

export function seedProducts(db: Db): number {
  if (listProducts(db).length > 0) return 0;
  for (const [sku, brand, name, flavor, strength, mg, priceKr, stock] of PRODUCTS) {
    const p = createProduct(db, { sku, brand, name, flavor, strength, nicotineMg: mg, priceOre: priceKr * 100, active: sku !== 'LYFT-LAKRITS' });
    if (stock > 0) adjustStock(db, p.id, stock, 'purchase', { note: 'Ingående saldo' });
  }
  return PRODUCTS.length;
}

export function seedSampleData(db: Db): number {
  if (countCustomers(db) > 0) return 0;

  // Leverantörer kopplas till varumärkena så att rapporterna kan filtreras per leverantör.
  const supplierByBrand = new Map<string, number>();
  for (const brand of new Set(PRODUCTS.map(([, b]) => b))) {
    supplierByBrand.set(brand, upsertSupplierByName(db, `${brand} Nordic AB`).id);
  }
  for (const product of listProducts(db)) {
    const supplierId = supplierByBrand.get(product.brand);
    if (supplierId) updateProduct(db, product.id, { supplierId });
  }

  const sku = (code: string) => findProductBySku(db, code)!.id;
  const thisPeriod = new Date().toISOString().slice(0, 7);
  const lastPeriod = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  // Förra månadens box: skickad, betygsatt och uppföljd.
  const previous = createEdition(db, { period: lastPeriod, name: `Mysterysnus ${periodLabel(lastPeriod)}`, description: 'Mintspecial' });
  for (const [code, qty] of [['VELO-ICE-COOL-S', 1], ['ZYN-COOL-MINT-S', 1], ['LOOP-MINT-MANIA', 1], ['KILLA-COLD-MINT', 1]] as [string, number][]) {
    setEditionItem(db, previous.id, sku(code), qty);
  }
  lockEdition(db, previous.id);

  // Den här månadens box: klar att plockas.
  const current = createEdition(db, { period: thisPeriod, name: `Mysterysnus ${periodLabel(thisPeriod)}`, description: 'Frukt och bär' });
  for (const [code, qty] of [['VELO-TROPIC', 1], ['ZYN-BELLINI', 1], ['NS-BERGAMOT', 1], ['XQS-BLUEBERRY', 1]] as [string, number][]) {
    setEditionItem(db, current.id, sku(code), qty);
  }
  lockEdition(db, current.id);

  const anna = createCustomer(db, {
    email: 'anna.andersson@example.com', firstName: 'Anna', lastName: 'Andersson', phone: '070-123 45 67',
    birthDate: '1988-03-12', street: 'Sveavägen 10', postalCode: '11157', city: 'Stockholm', marketingConsent: true,
  });
  const erik = createCustomer(db, {
    email: 'erik.eriksson@example.com', firstName: 'Erik', lastName: 'Eriksson', phone: '073-987 65 43',
    birthDate: '1995-11-02', street: 'Avenyn 5', postalCode: '41136', city: 'Göteborg',
  });
  const maja = createCustomer(db, {
    email: 'maja.svensson@example.com', firstName: 'Maja', lastName: 'Svensson',
    birthDate: '2001-07-23', street: 'Stortorget 2', postalCode: '21134', city: 'Malmö',
  });

  // Prenumerationer i olika vågor och lägen.
  const subAnna = createSubscription(db, { customerId: anna.id, wave: 1, paymentMethod: 'klarna', externalRef: 'STRIPE-SUB-001' }, 'seed');
  const subErik = createSubscription(db, { customerId: erik.id, wave: 2, paymentMethod: 'kort', externalRef: 'STRIPE-SUB-002' }, 'seed');
  const subMaja = createSubscription(db, { customerId: maja.id, wave: 3, paymentMethod: 'swish' }, 'seed');
  // Startdatum spridda över månaden så att vågfördelningen syns i demodatan.
  const joined = (dayOfMonth: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, dayOfMonth, 9)).toISOString();
  };
  for (const [sub, day] of [[subAnna, 3], [subErik, 10], [subMaja, 20]] as const) {
    db.prepare('UPDATE subscriptions SET started_at = ? WHERE id = ?').run(joined(day), sub.id);
  }

  // Förra månaden: boxen skickades till Anna och Erik och har levererats.
  let orderCount = 0;
  for (const [sub, carrier, tracking] of [[subAnna, 'postnord', '00370733350012345678'], [subErik, 'budbee', 'BUDBEE-55123']] as const) {
    const renewed = renewSubscription(db, sub.id, { period: lastPeriod, paymentStatus: 'paid', paymentRef: `PAY-${sub.id}-1`, advance: false }, 'seed');
    startPicking(db, renewed.order.id, 'seed');
    pack(db, renewed.order.id, 'seed');
    ship(db, renewed.order.id, { carrier, trackingNumber: tracking }, 'seed');
    markDelivered(db, renewed.order.id, 'seed');
    orderCount++;
  }

  // Betyg på förra månadens box.
  const ratings: [customerId: number, code: string, rating: number, sentiment: 'like' | 'dislike' | 'neutral', buyAgain: boolean, comment: string | null][] = [
    [anna.id, 'VELO-ICE-COOL-S', 5, 'like', true, 'Perfekt styrka och håller länge.'],
    [anna.id, 'ZYN-COOL-MINT-S', 4, 'like', true, null],
    [anna.id, 'LOOP-MINT-MANIA', 2, 'dislike', false, 'Alldeles för stark för mig.'],
    [anna.id, 'KILLA-COLD-MINT', 3, 'neutral', false, null],
    [erik.id, 'VELO-ICE-COOL-S', 4, 'like', true, null],
    [erik.id, 'ZYN-COOL-MINT-S', 3, 'neutral', false, 'Okej men inget jag skulle köpa själv.'],
    [erik.id, 'LOOP-MINT-MANIA', 5, 'like', true, 'Bästa i boxen! Vill ha mer av den här.'],
    [erik.id, 'KILLA-COLD-MINT', 4, 'like', true, null],
  ];
  for (const [customerId, code, rating, sentiment, buyAgain, comment] of ratings) {
    upsertProductRating(db, { customerId, editionId: previous.id, productId: sku(code), rating, sentiment, wouldBuyAgain: buyAgain, comment, source: 'seed' });
  }
  upsertEditionFeedback(db, { customerId: anna.id, editionId: previous.id, rating: 4, comment: 'Bra box, gärna mindre extra starkt nästa gång.' });
  upsertEditionFeedback(db, { customerId: erik.id, editionId: previous.id, rating: 5, comment: null });

  // Återförsäljare och köplänkar, med några klick och ett rapporterat köp.
  const snusbolaget = createRetailer(db, { name: 'Snusbolaget', website: 'https://exempel-snusbolaget.se' });
  const nikotinshop = createRetailer(db, { name: 'Nikotinshop', website: 'https://exempel-nikotinshop.se' });
  for (const [retailerId, code, priceKr] of [
    [snusbolaget.id, 'VELO-ICE-COOL-S', 42], [snusbolaget.id, 'LOOP-MINT-MANIA', 44], [snusbolaget.id, 'ZYN-COOL-MINT-S', 43],
    [nikotinshop.id, 'LOOP-MINT-MANIA', 41], [nikotinshop.id, 'KILLA-COLD-MINT', 49],
  ] as [number, string, number][]) {
    setRetailerLink(db, { retailerId, productId: sku(code), url: `https://exempel.se/${code.toLowerCase()}`, priceOre: priceKr * 100 });
  }
  const loopLink = db.prepare('SELECT id FROM retailer_links WHERE product_id = ? AND retailer_id = ?').get(sku('LOOP-MINT-MANIA'), snusbolaget.id) as { id: number };
  const veloLink = db.prepare('SELECT id FROM retailer_links WHERE product_id = ? AND retailer_id = ?').get(sku('VELO-ICE-COOL-S'), snusbolaget.id) as { id: number };
  const click = recordClick(db, loopLink.id, { customerId: erik.id, period: lastPeriod, source: 'seed' });
  recordConversion(db, click.conversionRef, { valueOre: 16_400 });
  recordClick(db, loopLink.id, { customerId: anna.id, period: lastPeriod, source: 'seed' });
  recordClick(db, veloLink.id, { customerId: anna.id, period: lastPeriod, source: 'seed' });

  // Den här månaden: Anna är packad, Erik betald och väntar på plock, Maja är pausad.
  const annaNow = renewSubscription(db, subAnna.id, { period: thisPeriod, paymentStatus: 'paid', paymentRef: 'PAY-NOW-1' }, 'seed');
  startPicking(db, annaNow.order.id, 'seed');
  pack(db, annaNow.order.id, 'seed');
  orderCount++;
  renewSubscription(db, subErik.id, { period: thisPeriod, paymentStatus: 'paid', paymentRef: 'PAY-NOW-2' }, 'seed');
  orderCount++;
  renewSubscription(db, subMaja.id, { period: thisPeriod }, 'seed');
  orderCount++;
  pauseSubscription(db, subMaja.id);

  void markPaid;
  return orderCount;
}


// Körs bara när filen startas direkt (`npm run seed`), inte när den importeras.
// pathToFileURL behövs för att jämförelsen ska fungera även på Windows.
const runDirectly = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (runDirectly) {
  const db = openDatabase(config.dbPath);
  migrate(db);
  const admin = seedAdmin(db);
  if (admin) {
    console.log(`Skapade admin-konto: ${admin}`);
    if (!process.env.ADMIN_PASSWORD) console.log(`  Lösenord: ${DEV_ADMIN_PASSWORD}  ← byt detta direkt (eller sätt ADMIN_PASSWORD).`);
  } else {
    console.log('Admin-konto finns redan.');
  }
  const products = seedProducts(db);
  if (products) console.log(`Lade in ${products} exempelprodukter.`);
  if (!isProduction()) {
    const orders = seedSampleData(db);
    if (orders) console.log(`Lade in exempelkunder, ${orders} exempelordrar, 2 månadsboxar med betyg och 3 prenumerationer.`);
  }
  console.log('Klart.');
  db.close();
}
