import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { idParam, paging, parseJson, parseQuery } from '../validate.ts';
import { customerPatchSchema, customerSchema } from '../schemas.ts';
import { createCustomer, getCustomer, listCustomers, updateCustomer } from '../../services/customers.ts';
import { listOrders } from '../../services/orders.ts';

export const customersApi = new Hono<AppEnv>()
  .get('/', (c) => {
    const q = parseQuery(c, paging);
    return c.json({ customers: listCustomers(c.get('db'), q) });
  })
  .post('/', async (c) => {
    const input = await parseJson(c, customerSchema);
    return c.json({ customer: createCustomer(c.get('db'), input) }, 201);
  })
  .get('/:id', (c) => c.json({ customer: getCustomer(c.get('db'), idParam(c)) }))
  .patch('/:id', async (c) => {
    const patch = await parseJson(c, customerPatchSchema);
    return c.json({ customer: updateCustomer(c.get('db'), idParam(c), patch) });
  })
  .get('/:id/orders', (c) => {
    const id = idParam(c);
    getCustomer(c.get('db'), id);
    return c.json({ orders: listOrders(c.get('db'), { customerId: id, limit: 200 }) });
  });
