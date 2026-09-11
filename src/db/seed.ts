/**
 * Fyller databasen med ett admin-konto och – utanför produktion – exempeldata
 * (produkter, kunder och ordrar i olika statusar). Kan köras flera gånger.
 */
import { config, isProduction } from '../config.ts';
import { migrate, openDatabase, type Db } from './connection.ts';
import { createStaffUser, listStaff } from '../services/auth.ts';
import { createProduct, listProducts } from '../services/products.ts';
import { adjustStock } from '../services/inventory.ts';
import { createCustomer, countCustomers } from '../services/customers.ts';
import { createOrder, markPaid, pack, ship, startPicking, markDelivered } from '../services/orders.ts';
import type { Strength } from '../domain/products.ts';
import { createSubscription, renewSubscription } from '../services/subscriptions.ts';

export function seedAdmin(db: Db): string | null {
  if (listStaff(db).length > 0) return null;
  const email = process.env.ADMIN_EMAIL ?? 'admin@mysterysnus.se';
  const password = process.env.ADMIN_PASSWORD ?? (isProduction() ? '' : 'admin123');
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
  const anna = createCustomer(db, {
    email: 'anna.andersson@example.com', firstName: 'Anna', lastName: 'Andersson', phone: '070-123 45 67',
    birthDate: '1988-03-12', street: 'Sveavägen 10', postalCode: '11157', city: 'Stockholm',
    prefStrength: 'strong', prefFlavors: ['mint'], marketingConsent: true,
  });
  const erik = createCustomer(db, {
    email: 'erik.eriksson@example.com', firstName: 'Erik', lastName: 'Eriksson', phone: '073-987 65 43',
    birthDate: '1995-11-02', street: 'Avenyn 5', postalCode: '41136', city: 'Göteborg',
    prefStrength: 'extra_strong', excludedFlavors: ['kaffe', 'lakrits'],
  });
  const maja = createCustomer(db, {
    email: 'maja.svensson@example.com', firstName: 'Maja', lastName: 'Svensson',
    birthDate: '2001-07-23', street: 'Stortorget 2', postalCode: '21134', city: 'Malmö',
    prefStrength: 'mild', prefFlavors: ['bär', 'citrus'],
  });

  // Väntar på betalning
  createOrder(db, { customerId: maja.id, lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }], paymentMethod: 'klarna', externalRef: 'SHOP-1001', channel: 'web' });
  // Betald – väntar på plock
  createOrder(db, {
    customerId: anna.id, paymentStatus: 'paid', paymentMethod: 'swish', paymentRef: 'SWISH-88213', externalRef: 'SHOP-1002',
    lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }, { kind: 'product', sku: 'ZYN-COOL-MINT-S', quantity: 3 }],
    customerNote: 'Gärna extra mycket mint!',
  });
  // Plockas
  const o3 = createOrder(db, { customerId: erik.id, paymentStatus: 'paid', paymentMethod: 'kort', externalRef: 'SHOP-1003', lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 2, strength: 'extra_strong' }] });
  startPicking(db, o3.id, 'seed');
  // Packad
  const o4 = createOrder(db, { customerId: anna.id, paymentStatus: 'paid', paymentMethod: 'swish', externalRef: 'SHOP-1004', lines: [{ kind: 'product', sku: 'VELO-ICE-COOL-S', quantity: 5 }, { kind: 'product', sku: 'KILLA-COLD-MINT', quantity: 5 }] });
  startPicking(db, o4.id, 'seed');
  pack(db, o4.id, 'seed');
  // Skickad
  const o5 = createOrder(db, { customerId: erik.id, paymentStatus: 'paid', paymentMethod: 'klarna', externalRef: 'SHOP-1005', lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }] });
  startPicking(db, o5.id, 'seed');
  pack(db, o5.id, 'seed');
  ship(db, o5.id, { carrier: 'postnord', service: 'MyPack Collect', trackingNumber: '00370733350012345678', pickupPoint: 'ICA Nära Avenyn' }, 'seed');
  // Levererad
  const o6 = createOrder(db, { customerId: maja.id, paymentStatus: 'paid', paymentMethod: 'swish', externalRef: 'SHOP-1006', lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }], placedAt: new Date(Date.now() - 14 * 86_400_000).toISOString() });
  startPicking(db, o6.id, 'seed');
  pack(db, o6.id, 'seed');
  ship(db, o6.id, { carrier: 'budbee', trackingNumber: 'BUDBEE-55123' }, 'seed');
  const o7 = createOrder(db, { customerId: anna.id, paymentStatus: 'paid', paymentMethod: 'kort', externalRef: 'SHOP-0999', lines: [{ kind: 'mystery_box', boxSize: 4, quantity: 1 }], placedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  startPicking(db, o7.id, 'seed');
  pack(db, o7.id, 'seed');
  ship(db, o7.id, { carrier: 'instabox', trackingNumber: 'IB-9981' }, 'seed');
  markDelivered(db, o7.id, 'seed');

  // Prenumerationer: Anna har fått sin första box (betald), Erik förnyas om några dagar, Maja är pausad.
  const subAnna = createSubscription(db, { customerId: anna.id, paymentMethod: 'klarna', externalRef: 'STRIPE-SUB-001', startAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }, 'seed');
  const renewed = renewSubscription(db, subAnna.id, { paymentStatus: 'paid', paymentRef: 'KL-77001' }, 'seed');
  markPaid; // (används inte – behålls för tydlighet i importen)
  void renewed;
  createSubscription(db, { customerId: erik.id, strength: 'extra_strong', paymentMethod: 'kort', externalRef: 'STRIPE-SUB-002', startAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }, 'seed');
  const subMaja = createSubscription(db, { customerId: maja.id, strength: 'mild', paymentMethod: 'swish', startAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), notes: 'Vill ha fruktiga smaker' }, 'seed');
  db.prepare("UPDATE subscriptions SET status = 'paused' WHERE id = ?").run(subMaja.id);
  return 8;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDatabase(config.dbPath);
  migrate(db);
  const admin = seedAdmin(db);
  if (admin) {
    console.log(`Skapade admin-konto: ${admin}`);
    if (!process.env.ADMIN_PASSWORD) console.log('  Lösenord: admin123  ← byt detta direkt (eller sätt ADMIN_PASSWORD).');
  }
  const products = seedProducts(db);
  if (products) console.log(`Lade in ${products} exempelprodukter.`);
  if (!isProduction()) {
    const orders = seedSampleData(db);
    if (orders) console.log(`Lade in exempelkunder, ${orders} exempelordrar och 3 prenumerationer.`);
  }
  console.log('Klart.');
  db.close();
}
