export const CARRIERS = ['postnord', 'dhl', 'budbee', 'instabox', 'bring', 'schenker', 'other'] as const;
export type Carrier = (typeof CARRIERS)[number];

export const CARRIER_LABELS: Record<Carrier, string> = {
  postnord: 'PostNord',
  dhl: 'DHL',
  budbee: 'Budbee',
  instabox: 'Instabox',
  bring: 'Bring',
  schenker: 'DB Schenker',
  other: 'Annan',
};

const TRACKING_URL: Partial<Record<Carrier, (tn: string) => string>> = {
  postnord: (tn) => `https://tracking.postnord.com/se/?id=${encodeURIComponent(tn)}`,
  dhl: (tn) => `https://www.dhl.com/se-sv/home/tracking.html?tracking-id=${encodeURIComponent(tn)}`,
  budbee: (tn) => `https://tracking.budbee.com/${encodeURIComponent(tn)}`,
  instabox: (tn) => `https://instabox.io/tracking/${encodeURIComponent(tn)}`,
  bring: (tn) => `https://tracking.bring.se/tracking/${encodeURIComponent(tn)}`,
  schenker: (tn) => `https://www.dbschenker.com/se-sv/spara-sandning?trackingNumber=${encodeURIComponent(tn)}`,
};

export function isCarrier(value: unknown): value is Carrier {
  return typeof value === 'string' && (CARRIERS as readonly string[]).includes(value);
}

export function trackingUrl(carrier: Carrier, trackingNumber: string | null): string | null {
  if (!trackingNumber) return null;
  const build = TRACKING_URL[carrier];
  return build ? build(trackingNumber) : null;
}

export const SHIPMENT_STATUSES = [
  'created',
  'label_printed',
  'in_transit',
  'at_pickup_point',
  'delivered',
  'returned',
  'failed',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  created: 'Skapad',
  label_printed: 'Etikett utskriven',
  in_transit: 'På väg',
  at_pickup_point: 'Hos ombud',
  delivered: 'Levererad',
  returned: 'Returnerad',
  failed: 'Misslyckad',
};

export function isShipmentStatus(value: unknown): value is ShipmentStatus {
  return typeof value === 'string' && (SHIPMENT_STATUSES as readonly string[]).includes(value);
}
