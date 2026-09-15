import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';
import { idParam, parseJson } from '../validate.ts';
import { createSupplier, getSupplier, listSuppliers, updateSupplier } from '../../services/suppliers.ts';
import { listProducts } from '../../services/products.ts';

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).nullish(),
  contactEmail: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  active: z.boolean().optional(),
});

export const suppliersApi = new Hono<AppEnv>()
  .get('/', (c) => c.json({ suppliers: listSuppliers(c.get('db')) }))
  .post('/', async (c) => c.json({ supplier: createSupplier(c.get('db'), await parseJson(c, supplierSchema)) }, 201))
  .get('/:id', (c) => {
    const id = idParam(c);
    const supplier = getSupplier(c.get('db'), id);
    return c.json({ supplier, products: listProducts(c.get('db')).filter((p) => p.supplierId === id) });
  })
  .patch('/:id', async (c) => c.json({ supplier: updateSupplier(c.get('db'), idParam(c), await parseJson(c, supplierSchema.partial())) }));
