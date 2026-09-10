import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { idParam, paging, parseJson, parseQuery } from '../validate.ts';
import { shipmentEventSchema, shipmentListQuery, shipmentPatchSchema } from '../schemas.ts';
import {
  addShipmentEvent,
  findShipmentByTracking,
  getShipment,
  listShipments,
  updateShipment,
} from '../../services/shipments.ts';
import { notFound } from '../../domain/errors.ts';
import { CARRIER_LABELS, CARRIERS } from '../../domain/carriers.ts';

export const shipmentsApi = new Hono<AppEnv>()
  .get('/', (c) => {
    const q = parseQuery(c, paging.merge(shipmentListQuery));
    return c.json({ shipments: listShipments(c.get('db'), q) });
  })
  .get('/carriers', (c) => c.json({ carriers: CARRIERS.map((id) => ({ id, label: CARRIER_LABELS[id] })) }))
  .get('/tracking/:trackingNumber', (c) => {
    const shipment = findShipmentByTracking(c.get('db'), c.req.param('trackingNumber'));
    if (!shipment) throw notFound('Försändelse', c.req.param('trackingNumber'));
    return c.json({ shipment });
  })
  /** Webhook-vänlig: registrera händelse via kollinummer. */
  .post('/tracking/:trackingNumber/events', async (c) => {
    const shipment = findShipmentByTracking(c.get('db'), c.req.param('trackingNumber'));
    if (!shipment) throw notFound('Försändelse', c.req.param('trackingNumber'));
    const input = await parseJson(c, shipmentEventSchema);
    return c.json({ shipment: addShipmentEvent(c.get('db'), shipment.id, input, c.get('actor')) });
  })
  .get('/:id', (c) => c.json({ shipment: getShipment(c.get('db'), idParam(c)) }))
  .patch('/:id', async (c) => {
    const patch = await parseJson(c, shipmentPatchSchema);
    return c.json({ shipment: updateShipment(c.get('db'), idParam(c), patch) });
  })
  .post('/:id/events', async (c) => {
    const input = await parseJson(c, shipmentEventSchema);
    return c.json({ shipment: addShipmentEvent(c.get('db'), idParam(c), input, c.get('actor')) });
  });
