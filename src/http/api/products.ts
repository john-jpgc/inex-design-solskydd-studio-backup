import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';
import { idParam, paging, parseJson, parseQuery } from '../validate.ts';
import { productPatchSchema, productSchema, stockAdjustSchema } from '../schemas.ts';
import { availableStock, createProduct, getProduct, listProducts, updateProduct } from '../../services/products.ts';
import { adjustStock, listMovements } from '../../services/inventory.ts';
import { listLinksForProduct } from '../../services/retailers.ts';
import { productHistory } from '../../services/reports.ts';

const listQuery = paging.extend({
  active: z.enum(['true', 'false']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
});

const withAvailable = <T extends { stockOnHand: number; stockReserved: number }>(p: T) => ({
  ...p,
  stockAvailable: availableStock(p),
});

export const productsApi = new Hono<AppEnv>()
  .get('/', (c) => {
    const q = parseQuery(c, listQuery);
    const products = listProducts(c.get('db'), {
      q: q.q,
      activeOnly: q.active === 'true',
      lowStockOnly: q.lowStock === 'true',
    }).map(withAvailable);
    return c.json({ products });
  })
  .post('/', async (c) => {
    const input = await parseJson(c, productSchema);
    return c.json({ product: withAvailable(createProduct(c.get('db'), input)) }, 201);
  })
  .get('/:id', (c) => c.json({ product: withAvailable(getProduct(c.get('db'), idParam(c))) }))
  .patch('/:id', async (c) => {
    const patch = await parseJson(c, productPatchSchema);
    return c.json({ product: withAvailable(updateProduct(c.get('db'), idParam(c), patch)) });
  })
  .post('/:id/stock', async (c) => {
    const input = await parseJson(c, stockAdjustSchema);
    const product = adjustStock(c.get('db'), idParam(c), input.delta, input.reason, {
      note: input.note ?? undefined,
      reference: c.get('actor'),
    });
    return c.json({ product: withAvailable(product) });
  })
  .get('/:id/retailers', (c) => {
    const q = parseQuery(c, z.object({ customerToken: z.string().trim().max(100).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }));
    const links = listLinksForProduct(c.get('db'), idParam(c), q);
    return c.json({ links: links.map((l) => ({ retailerId: l.retailerId, retailer: l.retailerName, priceOre: l.priceOre, url: l.trackingUrl })) });
  })
  /** Hur produkten tagits emot i de boxar den ingått i. */
  .get('/:id/history', (c) => c.json({ history: productHistory(c.get('db'), idParam(c)) }))
  .get('/:id/movements', (c) => {
    const id = idParam(c);
    getProduct(c.get('db'), id);
    return c.json({ movements: listMovements(c.get('db'), id) });
  });
