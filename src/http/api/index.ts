import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { requireApiAuth } from '../middleware.ts';
import { customersApi } from './customers.ts';
import { productsApi } from './products.ts';
import { ordersApi } from './orders.ts';
import { shipmentsApi } from './shipments.ts';
import { subscriptionsApi } from './subscriptions.ts';

export const api = new Hono<AppEnv>()
  .get('/health', (c) => c.json({ ok: true, service: 'mysterysnus-oms' }))
  .use('*', requireApiAuth)
  .route('/customers', customersApi)
  .route('/products', productsApi)
  .route('/orders', ordersApi)
  .route('/shipments', shipmentsApi)
  .route('/subscriptions', subscriptionsApi);
