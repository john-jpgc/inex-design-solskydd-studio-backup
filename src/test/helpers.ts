import { openTestDatabase, type Db } from '../db/connection.ts';
import { createCustomer, type Customer } from '../services/customers.ts';
import { createProduct, type Product } from '../services/products.ts';
import { adjustStock } from '../services/inventory.ts';

export function testDb(): Db {
  return openTestDatabase();
}

export function seedCustomer(db: Db, overrides: Partial<Parameters<typeof createCustomer>[1]> = {}): Customer {
  return createCustomer(db, {
    email: 'anna@example.com',
    firstName: 'Anna',
    lastName: 'Andersson',
    birthDate: '1990-05-15',
    street: 'Storgatan 1',
    postalCode: '11122',
    city: 'Stockholm',
    prefStrength: 'strong',
    prefFlavors: ['mint'],
    ...overrides,
  });
}

export function seedProduct(
  db: Db,
  sku: string,
  stock: number,
  overrides: Partial<Parameters<typeof createProduct>[1]> = {},
): Product {
  const p = createProduct(db, {
    sku,
    name: `Produkt ${sku}`,
    brand: 'Testbrand',
    flavor: 'mint',
    strength: 'strong',
    priceOre: 4_500,
    ...overrides,
  });
  if (stock > 0) adjustStock(db, p.id, stock, 'purchase', { note: 'seed' });
  return p;
}
