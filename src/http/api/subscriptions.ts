import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';
import { idParam, paging, parseJson, parseQuery } from '../validate.ts';
import { STRENGTHS } from '../../domain/products.ts';
import {
  cancelSubscription, createSubscription, findSubscriptionByExternalRef, getSubscription, listSubscriptions,
  pauseSubscription, renewDueSubscriptions, renewSubscription, resumeSubscription, subscriptionCounts, updateSubscription,
} from '../../services/subscriptions.ts';
import { listOrders } from '../../services/orders.ts';
import { notFound } from '../../domain/errors.ts';

const optionalText = (max = 200) => z.string().trim().max(max).nullish();

export const subscriptionSchema = z.object({
  customerId: z.number().int().positive(),
  boxSize: z.number().int().positive().max(200).optional(),
  quantity: z.number().int().positive().max(100).optional(),
  strength: z.enum(STRENGTHS).nullish(),
  priceOre: z.number().int().min(0).optional(),
  intervalMonths: z.number().int().min(1).max(12).optional(),
  startAt: z.string().datetime().optional(),
  externalRef: optionalText(200),
  paymentMethod: optionalText(50),
  notes: optionalText(2000),
});

const patchSchema = subscriptionSchema.omit({ customerId: true, startAt: true }).partial().extend({
  nextRenewalAt: z.string().datetime().optional(),
});

const renewSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  paymentStatus: z.enum(['unpaid', 'paid']).optional(),
  paymentRef: optionalText(200),
  advance: z.boolean().optional(),
});

const listQuery = paging.extend({
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
  customerId: z.coerce.number().int().positive().optional(),
});

export const subscriptionsApi = new Hono<AppEnv>()
  .get('/', (c) => c.json({ subscriptions: listSubscriptions(c.get('db'), parseQuery(c, listQuery)) }))
  .get('/stats', (c) => c.json(subscriptionCounts(c.get('db'))))
  .post('/', async (c) => {
    const input = await parseJson(c, subscriptionSchema);
    return c.json({ subscription: createSubscription(c.get('db'), input, c.get('actor')) }, 201);
  })
  /** Kör förnyelser för alla prenumerationer som förfallit – för cron/webhook. */
  .post('/renew-due', (c) => c.json(renewDueSubscriptions(c.get('db'), undefined, c.get('actor'))))
  .get('/external/:ref', (c) => {
    const s = findSubscriptionByExternalRef(c.get('db'), c.req.param('ref'));
    if (!s) throw notFound('Prenumeration', c.req.param('ref'));
    return c.json({ subscription: s });
  })
  .get('/:id', (c) => {
    const id = idParam(c);
    const subscription = getSubscription(c.get('db'), id);
    const orders = listOrders(c.get('db'), { customerId: subscription.customerId, limit: 100 }).filter((o) => o.subscriptionId === id);
    return c.json({ subscription, orders });
  })
  .patch('/:id', async (c) => {
    const patch = await parseJson(c, patchSchema);
    return c.json({ subscription: updateSubscription(c.get('db'), idParam(c), patch) });
  })
  .post('/:id/pause', (c) => c.json({ subscription: pauseSubscription(c.get('db'), idParam(c)) }))
  .post('/:id/resume', (c) => c.json({ subscription: resumeSubscription(c.get('db'), idParam(c)) }))
  .post('/:id/cancel', (c) => c.json({ subscription: cancelSubscription(c.get('db'), idParam(c)) }))
  /** Skapar periodens order. Idempotent per period – lämpligt att anropa från betalleverantörens webhook. */
  .post('/:id/renew', async (c) => {
    const input = await parseJson(c, renewSchema).catch(() => ({} as z.infer<typeof renewSchema>));
    const result = renewSubscription(c.get('db'), idParam(c), { ...input, paymentRef: input.paymentRef ?? null }, c.get('actor'));
    return c.json(result, result.created ? 201 : 200);
  });
