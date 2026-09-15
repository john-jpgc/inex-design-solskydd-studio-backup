import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { invalid, notFound } from '../domain/errors.ts';
import { isCarrier, trackingUrl, type Carrier, type ShipmentStatus } from '../domain/carriers.ts';
import { addOrderEvent, getOrder, markDelivered, markReturned } from './orders.ts';

const SHIPMENT_COLUMNS =
  'id, order_id, carrier, service, tracking_number, tracking_url, status, weight_grams, pickup_point, shipped_at, delivered_at, label_provider, label_ref, label_format, label_created_at, created_at, updated_at';

export interface Shipment {
  id: number;
  orderId: number;
  carrier: Carrier;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: ShipmentStatus;
  weightGrams: number | null;
  pickupPoint: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  labelProvider: string | null;
  labelRef: string | null;
  labelFormat: string | null;
  labelCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentEvent {
  id: number;
  shipmentId: number;
  status: ShipmentStatus;
  description: string | null;
  location: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface ShipmentDetail extends Shipment {
  orderNumber: string;
  events: ShipmentEvent[];
}

export interface ShipmentListItem extends Shipment {
  orderNumber: string;
  shipName: string;
  shipCity: string;
}

export interface ShipmentInput {
  carrier: Carrier;
  service?: string | null;
  trackingNumber?: string | null;
  weightGrams?: number | null;
  pickupPoint?: string | null;
  status?: ShipmentStatus;
}

export function createShipment(db: Db, orderId: number, input: ShipmentInput): Shipment {
  if (!isCarrier(input.carrier)) throw invalid('INVALID_CARRIER', `Okänd transportör: ${String(input.carrier)}`);
  const ts = now();
  const tn = input.trackingNumber?.trim() || null;
  const status = input.status ?? (tn ? 'in_transit' : 'created');
  const result = db
    .prepare(
      `INSERT INTO shipments (order_id, carrier, service, tracking_number, tracking_url, status, weight_grams, pickup_point, shipped_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId, input.carrier, input.service?.trim() || null, tn, trackingUrl(input.carrier, tn), status,
      input.weightGrams ?? null, input.pickupPoint?.trim() || null, ts, ts, ts,
    );
  const id = Number(result.lastInsertRowid);
  db.prepare(
    'INSERT INTO shipment_events (shipment_id, status, description, location, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, status, 'Försändelse registrerad', null, ts, ts);
  return getShipment(db, id);
}

export function getShipment(db: Db, id: number): ShipmentDetail {
  const row = db
    .prepare('SELECT s.id, s.order_id, s.carrier, s.service, s.tracking_number, s.tracking_url, s.status, s.weight_grams, s.pickup_point, s.shipped_at, s.delivered_at, s.label_provider, s.label_ref, s.label_format, s.label_created_at, s.created_at, s.updated_at, o.order_number FROM shipments s JOIN orders o ON o.id = s.order_id WHERE s.id = ?')
    .get(id) as Record<string, unknown> | undefined;
  const s = toCamel<ShipmentDetail>(row);
  if (!s) throw notFound('Försändelse', id);
  s.events = toCamelAll<ShipmentEvent>(
    db.prepare('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at DESC, id DESC').all(id) as Record<
      string,
      unknown
    >[],
  );
  return s;
}

export function listShipmentsForOrder(db: Db, orderId: number): Shipment[] {
  return toCamelAll<Shipment>(
    db.prepare(`SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE order_id = ? ORDER BY created_at DESC`).all(orderId) as Record<string, unknown>[],
  );
}

export function findShipmentByTracking(db: Db, trackingNumber: string): ShipmentDetail | undefined {
  const row = db.prepare('SELECT id FROM shipments WHERE tracking_number = ? ORDER BY created_at DESC').get(trackingNumber.trim()) as
    | { id: number }
    | undefined;
  return row ? getShipment(db, row.id) : undefined;
}

export function listShipments(
  db: Db,
  opts: { status?: ShipmentStatus; carrier?: Carrier; q?: string; limit?: number; offset?: number } = {},
): ShipmentListItem[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push('s.status = ?');
    params.push(opts.status);
  }
  if (opts.carrier) {
    where.push('s.carrier = ?');
    params.push(opts.carrier);
  }
  if (opts.q) {
    const like = `%${opts.q.trim()}%`;
    where.push('(s.tracking_number LIKE ? OR o.order_number LIKE ? OR o.ship_name LIKE ?)');
    params.push(like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT ${SHIPMENT_COLUMNS.replace(/(^|, )/g, '$1s.')}, o.order_number, o.ship_name, o.ship_city
       FROM shipments s JOIN orders o ON o.id = s.order_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(opts.limit ?? 50, 500), opts.offset ?? 0) as Record<string, unknown>[];
  return toCamelAll<ShipmentListItem>(rows);
}

export function updateShipment(
  db: Db,
  id: number,
  patch: { carrier?: Carrier; service?: string | null; trackingNumber?: string | null; weightGrams?: number | null; pickupPoint?: string | null },
): ShipmentDetail {
  const existing = getShipment(db, id);
  const carrier = patch.carrier ?? existing.carrier;
  if (!isCarrier(carrier)) throw invalid('INVALID_CARRIER', `Okänd transportör: ${String(carrier)}`);
  const tn = patch.trackingNumber === undefined ? existing.trackingNumber : patch.trackingNumber?.trim() || null;
  db.prepare(
    `UPDATE shipments SET carrier = ?, service = ?, tracking_number = ?, tracking_url = ?, weight_grams = ?, pickup_point = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    carrier,
    patch.service === undefined ? existing.service : patch.service?.trim() || null,
    tn,
    trackingUrl(carrier, tn),
    patch.weightGrams === undefined ? existing.weightGrams : patch.weightGrams,
    patch.pickupPoint === undefined ? existing.pickupPoint : patch.pickupPoint?.trim() || null,
    now(),
    id,
  );
  return getShipment(db, id);
}

/**
 * Registrerar en spårningshändelse (t.ex. från transportörens webhook) och
 * uppdaterar både försändelsen och ordern.
 */
export function addShipmentEvent(
  db: Db,
  shipmentId: number,
  input: { status: ShipmentStatus; description?: string | null; location?: string | null; occurredAt?: string | null },
  actor = 'carrier',
): ShipmentDetail {
  return transaction(db, () => {
    const shipment = getShipment(db, shipmentId);
    const occurredAt = input.occurredAt ?? now();
    const ts = now();
    db.prepare(
      'INSERT INTO shipment_events (shipment_id, status, description, location, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(shipmentId, input.status, input.description?.trim() || null, input.location?.trim() || null, occurredAt, ts);

    const deliveredAt = input.status === 'delivered' ? occurredAt : shipment.deliveredAt;
    db.prepare('UPDATE shipments SET status = ?, delivered_at = ?, updated_at = ? WHERE id = ?').run(
      input.status, deliveredAt, ts, shipmentId,
    );

    const order = getOrder(db, shipment.orderId);
    if (input.status === 'delivered' && order.status === 'shipped') {
      markDelivered(db, order.id, actor, occurredAt);
    } else if (input.status === 'returned' && (order.status === 'shipped' || order.status === 'delivered')) {
      markReturned(db, order.id, { restock: false, reason: 'Försändelsen returnerades av transportören' }, actor);
    } else {
      addOrderEvent(db, order.id, 'shipment_event', `Försändelse ${shipment.trackingNumber ?? `#${shipmentId}`}: ${input.status}${input.location ? ` (${input.location})` : ''}`, actor);
    }
    return getShipment(db, shipmentId);
  });
}
