import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { config } from '../config.ts';
import { AppError, notFound } from '../domain/errors.ts';
import { getLabelProvider, type LabelFormat, type LabelRequest } from '../logistics/index.ts';
import { trackingUrl } from '../domain/carriers.ts';
import { getShipment, type ShipmentDetail } from './shipments.ts';
import { addOrderEvent, getOrder } from './orders.ts';

export interface StoredLabel {
  format: LabelFormat;
  data: Uint8Array;
  provider: string;
  createdAt: string;
}

export function labelProviderStatus(): { id: string; name: string; configured: boolean } {
  const p = getLabelProvider();
  return { id: p.id, name: p.name, configured: p.isConfigured() };
}

export function buildLabelRequest(db: Db, shipment: ShipmentDetail): LabelRequest {
  const order = getOrder(db, shipment.orderId);
  return {
    shipmentId: shipment.id,
    orderNumber: order.orderNumber,
    carrier: shipment.carrier,
    service: shipment.service,
    sender: { ...config.sender },
    recipient: {
      name: order.shipName,
      street: order.shipStreet,
      postalCode: order.shipPostalCode,
      city: order.shipCity,
      country: order.shipCountry,
      phone: order.shipPhone ?? order.customer.phone,
      email: order.customer.email,
    },
    weightGrams: shipment.weightGrams ?? 100,
    pickupPoint: shipment.pickupPoint,
    reference: order.orderNumber,
  };
}

/** Bokar försändelsen hos etikettleverantören och sparar kollinummer + etikett. */
export async function createLabelForShipment(db: Db, shipmentId: number, actor = 'system'): Promise<ShipmentDetail> {
  const provider = getLabelProvider();
  if (!provider.isConfigured()) {
    throw new AppError(
      501,
      'LABEL_PROVIDER_NOT_CONFIGURED',
      provider.id === 'manual'
        ? 'Ingen etikettleverantör är konfigurerad. Sätt LABEL_PROVIDER=nshift eller postnord och tillhörande nycklar i .env.'
        : `${provider.name} saknar nycklar – se .env.example`,
    );
  }
  const shipment = getShipment(db, shipmentId);
  if (shipment.labelRef || shipment.labelCreatedAt) {
    throw new AppError(409, 'LABEL_EXISTS', 'Försändelsen har redan en etikett');
  }
  if (provider.carriers.length && !provider.carriers.includes(shipment.carrier)) {
    throw new AppError(422, 'UNSUPPORTED_CARRIER', `${provider.name} kan inte boka ${shipment.carrier}`);
  }
  if (!config.sender.street || !config.sender.postalCode || !config.sender.city) {
    throw new AppError(422, 'MISSING_SENDER', 'Avsändaradress saknas – sätt SENDER_STREET, SENDER_POSTAL_CODE och SENDER_CITY');
  }

  const result = await provider.createLabel(buildLabelRequest(db, shipment));

  return transaction(db, () => {
    const ts = now();
    db.prepare(
      `UPDATE shipments SET tracking_number = ?, tracking_url = ?, status = CASE WHEN status = 'created' THEN 'label_printed' ELSE status END,
         label_provider = ?, label_ref = ?, label_format = ?, label_data = ?, label_created_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      result.trackingNumber, result.trackingUrl ?? trackingUrl(shipment.carrier, result.trackingNumber), provider.id, result.providerRef ?? null,
      result.label?.format ?? null, result.label ? result.label.data : null, ts, ts, shipmentId,
    );
    db.prepare(
      'INSERT INTO shipment_events (shipment_id, status, description, location, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(shipmentId, 'label_printed', `Etikett skapad via ${provider.name}`, null, ts, ts);
    addOrderEvent(db, shipment.orderId, 'label', `Etikett skapad via ${provider.name}, kolli ${result.trackingNumber}`, actor, { shipmentId });
    return getShipment(db, shipmentId);
  });
}

export function getStoredLabel(db: Db, shipmentId: number): StoredLabel {
  const row = db
    .prepare('SELECT label_provider, label_format, label_data, label_created_at FROM shipments WHERE id = ?')
    .get(shipmentId) as { label_provider: string | null; label_format: string | null; label_data: Uint8Array | null; label_created_at: string | null } | undefined;
  if (!row) throw notFound('Försändelse', shipmentId);
  if (!row.label_data || !row.label_format) throw notFound('Etikett för försändelse', shipmentId);
  return { format: row.label_format as LabelFormat, data: row.label_data, provider: row.label_provider ?? 'unknown', createdAt: row.label_created_at ?? '' };
}

export const LABEL_CONTENT_TYPES: Record<LabelFormat, string> = {
  pdf: 'application/pdf',
  zpl: 'text/plain; charset=utf-8',
  png: 'image/png',
};
