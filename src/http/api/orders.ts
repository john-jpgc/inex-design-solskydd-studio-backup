import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { idParam, paging, parseJson, parseQuery } from '../validate.ts';
import {
  boxPicksSchema,
  cancelSchema,
  createOrderSchema,
  noteSchema,
  orderListQuery,
  paySchema,
  pickSchema,
  returnSchema,
  shipmentInputSchema,
} from '../schemas.ts';
import {
  cancelOrder,
  cancelPicking,
  createOrder,
  findOrderByNumber,
  getOrder,
  listOrders,
  markDelivered,
  markPaid,
  markRefunded,
  markReturned,
  orderStatusCounts,
  pack,
  reopenForPicking,
  setBoxPicks,
  setInternalNote,
  ship,
  startPicking,
} from '../../services/orders.ts';
import { notFound } from '../../domain/errors.ts';

export const ordersApi = new Hono<AppEnv>()
  .get('/', (c) => {
    const q = parseQuery(c, paging.merge(orderListQuery));
    return c.json({ orders: listOrders(c.get('db'), { ...q, status: q.status }) });
  })
  .get('/stats', (c) => c.json({ byStatus: orderStatusCounts(c.get('db')) }))
  .post('/', async (c) => {
    const input = await parseJson(c, createOrderSchema);
    return c.json({ order: createOrder(c.get('db'), input, c.get('actor')) }, 201);
  })
  .get('/number/:orderNumber', (c) => {
    const order = findOrderByNumber(c.get('db'), c.req.param('orderNumber'));
    if (!order) throw notFound('Order', c.req.param('orderNumber'));
    return c.json({ order });
  })
  .get('/:id', (c) => c.json({ order: getOrder(c.get('db'), idParam(c)) }))
  .patch('/:id', async (c) => {
    const input = await parseJson(c, noteSchema);
    return c.json({ order: setInternalNote(c.get('db'), idParam(c), input.internalNote, c.get('actor')) });
  })
  .post('/:id/pay', async (c) => {
    const input = await parseJson(c, paySchema);
    return c.json({ order: markPaid(c.get('db'), idParam(c), input, c.get('actor')) });
  })
  .post('/:id/pick', async (c) => {
    const input = await parseJson(c, pickSchema).catch(() => ({ seed: undefined }));
    return c.json({ order: startPicking(c.get('db'), idParam(c), c.get('actor'), input) });
  })
  .put('/:id/lines/:lineId/picks', async (c) => {
    const input = await parseJson(c, boxPicksSchema);
    return c.json({ order: setBoxPicks(c.get('db'), idParam(c), idParam(c, 'lineId'), input.picks, c.get('actor')) });
  })
  .post('/:id/cancel-picking', (c) => c.json({ order: cancelPicking(c.get('db'), idParam(c), c.get('actor')) }))
  .post('/:id/pack', (c) => c.json({ order: pack(c.get('db'), idParam(c), c.get('actor')) }))
  .post('/:id/reopen', (c) => c.json({ order: reopenForPicking(c.get('db'), idParam(c), c.get('actor')) }))
  .post('/:id/ship', async (c) => {
    const input = await parseJson(c, shipmentInputSchema);
    return c.json({ order: ship(c.get('db'), idParam(c), input, c.get('actor')) });
  })
  .post('/:id/deliver', (c) => c.json({ order: markDelivered(c.get('db'), idParam(c), c.get('actor')) }))
  .post('/:id/cancel', async (c) => {
    const input = await parseJson(c, cancelSchema).catch(() => ({ reason: '' }));
    return c.json({ order: cancelOrder(c.get('db'), idParam(c), input.reason, c.get('actor')) });
  })
  .post('/:id/return', async (c) => {
    const input = await parseJson(c, returnSchema).catch(() => ({ restock: false, reason: undefined }));
    return c.json({ order: markReturned(c.get('db'), idParam(c), { restock: input.restock, reason: input.reason ?? undefined }, c.get('actor')) });
  })
  .post('/:id/refund', (c) => c.json({ order: markRefunded(c.get('db'), idParam(c), c.get('actor')) }));
