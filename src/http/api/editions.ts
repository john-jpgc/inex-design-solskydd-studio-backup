import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';
import { idParam, parseJson, parseQuery } from '../validate.ts';
import {
  archiveEdition, createEdition, editionForecast, findEditionByPeriod, getEdition, listEditions,
  lockEdition, replaceEditionItems, setEditionItem, unlockEdition, updateEdition,
} from '../../services/editions.ts';
import { editionReport, editionReportCsv } from '../../services/reports.ts';
import { listLinksForProduct } from '../../services/retailers.ts';
import { notFound } from '../../domain/errors.ts';

const period = z.string().regex(/^\d{4}-\d{2}$/, 'Period anges som ÅÅÅÅ-MM');

const createSchema = z.object({
  period,
  name: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
});

const itemsSchema = z.object({
  items: z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(0).max(100) })).max(50),
});

const reportQuery = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  comments: z.enum(['true', 'false']).optional(),
});

export const editionsApi = new Hono<AppEnv>()
  .get('/', (c) => c.json({ editions: listEditions(c.get('db')) }))
  .post('/', async (c) => c.json({ edition: createEdition(c.get('db'), await parseJson(c, createSchema)) }, 201))
  .get('/period/:period', (c) => {
    const edition = findEditionByPeriod(c.get('db'), c.req.param('period'));
    if (!edition) throw notFound('Box', c.req.param('period'));
    return c.json({ edition });
  })
  .get('/:id', (c) => c.json({ edition: getEdition(c.get('db'), idParam(c)) }))
  .patch('/:id', async (c) => {
    const patch = await parseJson(c, createSchema.partial().omit({ period: true }));
    return c.json({ edition: updateEdition(c.get('db'), idParam(c), patch) });
  })
  .put('/:id/items', async (c) => {
    const { items } = await parseJson(c, itemsSchema);
    return c.json({ edition: replaceEditionItems(c.get('db'), idParam(c), items) });
  })
  .put('/:id/items/:productId', async (c) => {
    const { quantity } = await parseJson(c, z.object({ quantity: z.number().int().min(0).max(100) }));
    return c.json({ edition: setEditionItem(c.get('db'), idParam(c), idParam(c, 'productId'), quantity) });
  })
  .post('/:id/lock', (c) => c.json({ edition: lockEdition(c.get('db'), idParam(c)) }))
  .post('/:id/unlock', (c) => c.json({ edition: unlockEdition(c.get('db'), idParam(c)) }))
  .post('/:id/archive', (c) => c.json({ edition: archiveEdition(c.get('db'), idParam(c)) }))
  .get('/:id/forecast', (c) => c.json(editionForecast(c.get('db'), idParam(c))))
  /** Loggdata till leverantörerna: betyg och merköp per produkt. */
  .get('/:id/report', (c) => {
    const q = parseQuery(c, reportQuery);
    return c.json(editionReport(c.get('db'), idParam(c), { supplierId: q.supplierId, includeComments: q.comments !== 'false' }));
  })
  .get('/:id/report.csv', (c) => {
    const q = parseQuery(c, reportQuery);
    const id = idParam(c);
    const edition = getEdition(c.get('db'), id);
    return c.body(editionReportCsv(c.get('db'), id, { supplierId: q.supplierId }), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mysterysnus-${edition.period}.csv"`,
    });
  })
  /** Köplänkar för allt i månadens box – används av "köp mer"-knapparna på hemsidan. */
  .get('/:id/retail-links', (c) => {
    const q = parseQuery(c, z.object({ customerToken: z.string().trim().max(100).optional() }));
    const edition = getEdition(c.get('db'), idParam(c));
    return c.json({
      period: edition.period,
      products: edition.items.map((item) => ({
        productId: item.productId,
        sku: item.sku,
        name: item.productName,
        brand: item.brand,
        links: listLinksForProduct(c.get('db'), item.productId, { customerToken: q.customerToken, period: edition.period }).map((l) => ({
          retailerId: l.retailerId,
          retailer: l.retailerName,
          priceOre: l.priceOre,
          url: l.trackingUrl,
        })),
      })),
    });
  });
