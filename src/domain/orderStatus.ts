export const ORDER_STATUSES = [
  'pending',
  'paid',
  'picking',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['picking', 'cancelled'],
  picking: ['packed', 'paid', 'cancelled'],
  packed: ['shipped', 'picking', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Väntar på betalning',
  paid: 'Betald',
  picking: 'Plockas',
  packed: 'Packad',
  shipped: 'Skickad',
  delivered: 'Levererad',
  cancelled: 'Avbruten',
  returned: 'Returnerad',
};

/** Statusar där ordern fortfarande är "öppen" och behöver hanteras av lagret. */
export const OPEN_STATUSES: readonly OrderStatus[] = ['paid', 'picking', 'packed'];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

/** Statusar där reserverat lager ännu inte har dragits från saldot. */
export function holdsReservation(status: OrderStatus): boolean {
  return status === 'pending' || status === 'paid' || status === 'picking';
}
