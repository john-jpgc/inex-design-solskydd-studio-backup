import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';
import { idParam, parseJson, parseQuery } from '../validate.ts';
import {
  clickStats, createRetailer, deleteRetailerLink, getRetailer, listAllLinks, listLinksForProduct,
  listRetailers, recordConversion, setRetailerLink, updateRetailer,
} from '../../services/retailers.ts';

const retailerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  active: z.boolean().optional(),
});

const linkSchema = z.object({
  retailerId: z.number().int().positive(),
  productId: z.number().int().positive(),
  url: z.string().trim().min(1).max(1000),
  priceOre: z.number().int().min(0).nullish(),
  active: z.boolean().optional(),
});

const conversionSchema = z.object({
  ref: z.string().trim().min(1).max(100),
  valueOre: z.number().int().min(0).nullish(),
  occurredAt: z.string().datetime().nullish(),
});

export const retailersApi = new Hono<AppEnv>()
  .get('/', (c) => c.json({ retailers: listRetailers(c.get('db')) }))
  .post('/', async (c) => c.json({ retailer: createRetailer(c.get('db'), await parseJson(c, retailerSchema)) }, 201))
  .get('/links', (c) => c.json({ links: listAllLinks(c.get('db')) }))
  .put('/links', async (c) => c.json({ link: setRetailerLink(c.get('db'), await parseJson(c, linkSchema)) }))
  .delete('/links/:id', (c) => {
    deleteRetailerLink(c.get('db'), idParam(c));
    return c.json({ ok: true });
  })
  /** Återförsäljaren rapporterar att ett spårat klick ledde till köp. */
  .post('/conversions', async (c) => {
    const input = await parseJson(c, conversionSchema);
    return c.json(recordConversion(c.get('db'), input.ref, { valueOre: input.valueOre, occurredAt: input.occurredAt }));
  })
  .get('/stats', (c) => {
    const q = parseQuery(c, z.object({ editionId: z.coerce.number().int().positive().optional(), productId: z.coerce.number().int().positive().optional() }));
    return c.json({ stats: clickStats(c.get('db'), q) });
  })
  .get('/for-product/:productId', (c) => {
    const q = parseQuery(c, z.object({ customerToken: z.string().trim().max(100).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }));
    const links = listLinksForProduct(c.get('db'), idParam(c, 'productId'), q);
    return c.json({ links: links.map((l) => ({ retailerId: l.retailerId, retailer: l.retailerName, priceOre: l.priceOre, url: l.trackingUrl })) });
  })
  .get('/:id', (c) => c.json({ retailer: getRetailer(c.get('db'), idParam(c)) }))
  .patch('/:id', async (c) => c.json({ retailer: updateRetailer(c.get('db'), idParam(c), await parseJson(c, retailerSchema.partial())) }));
