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
import { createLabelForShipment, getStoredLabel, LABEL_CONTENT_TYPES, labelProviderStatus } from '../../services/labels.ts';
import { CARRIER_LABELS, CARRIERS } from '../../domain/carriers.ts';

export const shipmentsApi = new Hono<AppEnv>()
  .get('/', (c) => {
    const q = parseQuery(c, paging.merge(shipmentListQuery));
    return c.json({ shipments: listShipments(c.get('db'), q) });
  })
  .get('/carriers', (c) => c.json({ carriers: CARRIERS.map((id) => ({ id, label: CARRIER_LABELS[id] })), labelProvider: labelProviderStatus() }))
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
  /** Bokar försändelsen hos etikettleverantören (LABEL_PROVIDER) och sparar etikett + kollinummer. */
  .post('/:id/label', async (c) => c.json({ shipment: await createLabelForShipment(c.get('db'), idParam(c), c.get('actor')) }, 201))
  .get('/:id/label', (c) => {
    const label = getStoredLabel(c.get('db'), idParam(c));
    return c.body(new Uint8Array(label.data).buffer as ArrayBuffer, 200, {
      'Content-Type': LABEL_CONTENT_TYPES[label.format],
      'Content-Disposition': `inline; filename="etikett-${c.req.param('id')}.${label.format}"`,
    });
  })
  .post('/:id/events', async (c) => {
    const input = await parseJson(c, shipmentEventSchema);
    return c.json({ shipment: addShipmentEvent(c.get('db'), idParam(c), input, c.get('actor')) });
  });
