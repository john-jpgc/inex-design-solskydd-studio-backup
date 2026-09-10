import type { Db } from '../db/connection.ts';
import { now, transaction } from '../db/connection.ts';
import { toCamel, toCamelAll } from '../db/rows.ts';
import { config } from '../config.ts';
import { AppError, invalid, notFound } from '../domain/errors.ts';
import { vatFromGross } from '../domain/money.ts';
import {
  canTransition,
  holdsReservation,
  isOrderStatus,
  ORDER_STATUSES,
  STATUS_LABELS,
  type OrderStatus,
} from '../domain/orderStatus.ts';
import { pickMysteryBox, totalQuantity, type BoxPick, type PickCandidate } from '../domain/boxPicker.ts';
import { STRENGTH_LABELS, type Strength } from '../domain/products.ts';
import { assertOfAge, fullName, getCustomer, upsertCustomerByEmail, type Customer, type CustomerInput } from './customers.ts';
import { availableStock, findProductBySku, getProduct, listProducts } from './products.ts';
import { adjustStock, commitReserved, consumeStock, releaseStock, reserveStock } from './inventory.ts';
import { createShipment, listShipmentsForOrder, type Shipment, type ShipmentInput } from './shipments.ts';

export type PaymentStatus = 'unpaid' | 'paid' | 'refund_due' | 'refunded';

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'Obetald',
  paid: 'Betald',
  refund_due: 'Återbetalning väntar',
  refunded: 'Återbetald',
};

export interface Order {
  id: number;
  orderNumber: string;
  customerId: number;
  status: OrderStatus;
  channel: string;
  externalRef: string | null;
  paymentMethod: string | null;
  paymentStatus: PaymentStatus;
  paymentRef: string | null;
  shipName: string;
  shipStreet: string;
  shipPostalCode: string;
  shipCity: string;
  shipCountry: string;
  shipPhone: string | null;
  subtotalOre: number;
  shippingOre: number;
  vatOre: number;
  totalOre: number;
  currency: string;
  ageVerified: boolean;
  customerNote: string | null;
  internalNote: string | null;
  placedAt: string;
  paidAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderListItem extends Order {
  customerName: string;
  customerEmail: string;
  lineCount: number;
}

export interface BoxPickRow {
  id: number;
  orderLineId: number;
  productId: number;
  quantity: number;
  sku: string;
  productName: string;
  brand: string;
  flavor: string;
  strength: Strength;
}

export interface OrderLine {
  id: number;
  orderId: number;
  kind: 'product' | 'mystery_box';
  productId: number | null;
  sku: string | null;
  description: string;
  quantity: number;
  unitPriceOre: number;
  vatRate: number;
  boxSize: number | null;
  boxStrength: Strength | null;
  picks: BoxPickRow[];
}

export interface OrderEvent {
  id: number;
  orderId: number;
  type: string;
  message: string;
  actor: string;
  data: unknown;
  createdAt: string;
}

export interface OrderDetail extends Order {
  customer: Customer;
  lines: OrderLine[];
  shipments: Shipment[];
  events: OrderEvent[];
}

export type OrderLineInput =
  | { kind: 'product'; productId?: number; sku?: string; quantity: number; unitPriceOre?: number }
  | { kind: 'mystery_box'; boxSize: number; quantity: number; strength?: Strength | null; unitPriceOre?: number };

export interface ShippingAddressInput {
  name?: string;
  street: string;
  postalCode: string;
  city: string;
  country?: string;
  phone?: string | null;
}

export interface CreateOrderInput {
  customerId?: number;
  /** Alternativ till customerId: kunden skapas/uppdateras utifrån e-post. */
  customer?: CustomerInput;
  lines: OrderLineInput[];
  shippingAddress?: ShippingAddressInput;
  paymentMethod?: string | null;
  paymentStatus?: 'unpaid' | 'paid';
  paymentRef?: string | null;
  /** Fraktkostnad i öre. Utelämnas → beräknas enligt fraktreglerna. */
  shippingOre?: number;
  channel?: string;
  /** T.ex. ordernummer i webbshopen. Unikt – dubbletter avvisas. */
  externalRef?: string | null;
  customerNote?: string | null;
  ageVerified?: boolean;
  placedAt?: string;
}

export const ORDER_NUMBER_PREFIX = 'MS';

export function formatOrderNumber(id: number): string {
  return `${ORDER_NUMBER_PREFIX}-${String(id).padStart(6, '0')}`;
}

function assertTransition(order: Order, to: OrderStatus): void {
  if (!canTransition(order.status, to)) {
    throw new AppError(
      409,
      'INVALID_TRANSITION',
      `Order ${order.orderNumber} är "${STATUS_LABELS[order.status]}" och kan inte gå till "${STATUS_LABELS[to]}"`,
    );
  }
}

function setStatus(db: Db, id: number, status: OrderStatus, extra: Record<string, string | number | null> = {}) {
  const sets = ['status = ?', 'updated_at = ?'];
  const params: (string | number | null)[] = [status, now()];
  for (const [col, val] of Object.entries(extra)) {
    sets.push(`${col} = ?`);
    params.push(val);
  }
  params.push(id);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function addOrderEvent(db: Db, orderId: number, type: string, message: string, actor = 'system', data?: unknown): void {
  db.prepare('INSERT INTO order_events (order_id, type, message, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    orderId, type, message, actor, data === undefined ? null : JSON.stringify(data), now(),
  );
}

export function computeShippingOre(subtotalOre: number): number {
  return subtotalOre >= config.shipping.freeThresholdOre ? 0 : config.shipping.standardOre;
}

export function createOrder(db: Db, input: CreateOrderInput, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    let customer: Customer;
    if (input.customerId != null) customer = getCustomer(db, input.customerId);
    else if (input.customer) customer = upsertCustomerByEmail(db, input.customer);
    else throw invalid('MISSING_CUSTOMER', 'Ange customerId eller customer');

    if (customer.status === 'blocked') throw new AppError(403, 'CUSTOMER_BLOCKED', 'Kunden är spärrad');
    assertOfAge(customer.birthDate);

    if (input.externalRef) {
      const dup = db.prepare('SELECT order_number FROM orders WHERE external_ref = ?').get(input.externalRef) as
        | { order_number: string }
        | undefined;
      if (dup) throw new AppError(409, 'DUPLICATE_ORDER', `Ordern finns redan som ${dup.order_number}`);
    }

    const addr = input.shippingAddress ?? {
      street: customer.street ?? '',
      postalCode: customer.postalCode ?? '',
      city: customer.city ?? '',
      country: customer.country,
      phone: customer.phone,
    };
    if (!addr.street?.trim() || !addr.postalCode?.trim() || !addr.city?.trim()) {
      throw invalid('MISSING_ADDRESS', 'Leveransadress (gata, postnummer, ort) krävs');
    }

    if (!input.lines?.length) throw invalid('EMPTY_ORDER', 'Ordern måste innehålla minst en rad');

    type ResolvedLine = {
      kind: 'product' | 'mystery_box';
      productId: number | null;
      description: string;
      quantity: number;
      unitPriceOre: number;
      vatRate: number;
      boxSize: number | null;
      boxStrength: Strength | null;
    };
    const lines: ResolvedLine[] = [];
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw invalid('INVALID_QUANTITY', 'Antal måste vara ett positivt heltal');
      if (line.kind === 'product') {
        const product =
          line.productId != null ? getProduct(db, line.productId) : line.sku ? findProductBySku(db, line.sku) : undefined;
        if (!product) throw notFound('Produkt', line.sku ?? line.productId ?? '?');
        if (!product.active) throw invalid('PRODUCT_INACTIVE', `${product.sku} säljs inte längre`);
        lines.push({
          kind: 'product',
          productId: product.id,
          description: `${product.brand} ${product.name}`,
          quantity: line.quantity,
          unitPriceOre: Math.round(line.unitPriceOre ?? product.priceOre),
          vatRate: product.vatRate,
          boxSize: null,
          boxStrength: null,
        });
      } else {
        if (!Number.isInteger(line.boxSize) || line.boxSize <= 0) throw invalid('INVALID_BOX_SIZE', 'Boxstorlek måste vara ett positivt heltal');
        const price = line.unitPriceOre ?? config.mysteryBoxPricesOre[line.boxSize];
        if (price == null) throw invalid('UNKNOWN_BOX_SIZE', `Inget pris finns för box med ${line.boxSize} dosor – ange unitPriceOre`);
        const strength = line.strength ?? null;
        lines.push({
          kind: 'mystery_box',
          productId: null,
          description: `Mystery box ${line.boxSize} dosor${strength ? ` (${STRENGTH_LABELS[strength]})` : ''}`,
          quantity: line.quantity,
          unitPriceOre: Math.round(price),
          vatRate: config.vatRate,
          boxSize: line.boxSize,
          boxStrength: strength,
        });
      }
    }

    const subtotalOre = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceOre, 0);
    const shippingOre = input.shippingOre != null ? Math.round(input.shippingOre) : computeShippingOre(subtotalOre);
    const vatOre =
      lines.reduce((sum, l) => sum + vatFromGross(l.quantity * l.unitPriceOre, l.vatRate), 0) +
      vatFromGross(shippingOre, config.vatRate);
    const totalOre = subtotalOre + shippingOre;

    const paid = input.paymentStatus === 'paid';
    const ts = now();
    const placedAt = input.placedAt ?? ts;
    const nextId = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM orders').get() as { id: number }).id;
    const orderNumber = formatOrderNumber(nextId);

    db.prepare(
      `INSERT INTO orders (id, order_number, customer_id, status, channel, external_ref, payment_method, payment_status, payment_ref,
         ship_name, ship_street, ship_postal_code, ship_city, ship_country, ship_phone,
         subtotal_ore, shipping_ore, vat_ore, total_ore, currency, age_verified, customer_note,
         placed_at, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nextId, orderNumber, customer.id, paid ? 'paid' : 'pending', input.channel ?? 'web', input.externalRef ?? null,
      input.paymentMethod ?? null, paid ? 'paid' : 'unpaid', input.paymentRef ?? null,
      addr.name?.trim() || fullName(customer), addr.street.trim(), addr.postalCode.replace(/\s+/g, ''), addr.city.trim(),
      (addr.country ?? 'SE').toUpperCase(), addr.phone?.trim() || null,
      subtotalOre, shippingOre, vatOre, totalOre, config.currency, input.ageVerified ? 1 : 0, input.customerNote?.trim() || null,
      placedAt, paid ? placedAt : null, ts, ts,
    );

    const insertLine = db.prepare(
      `INSERT INTO order_lines (order_id, kind, product_id, description, quantity, unit_price_ore, vat_rate, box_size, box_strength)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) {
      insertLine.run(nextId, l.kind, l.productId, l.description, l.quantity, l.unitPriceOre, l.vatRate, l.boxSize, l.boxStrength);
      if (l.kind === 'product' && l.productId != null) reserveStock(db, l.productId, l.quantity, orderNumber);
    }

    addOrderEvent(db, nextId, 'created', `Order ${orderNumber} skapad via ${input.channel ?? 'web'}`, actor);
    if (paid) addOrderEvent(db, nextId, 'paid', `Betald (${input.paymentMethod ?? 'okänd metod'})`, actor);
    return getOrder(db, nextId);
  });
}

export function getOrder(db: Db, id: number): OrderDetail {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const order = toCamel<OrderDetail>(row, { bool: ['ageVerified'] });
  if (!order) throw notFound('Order', id);
  order.customer = getCustomer(db, order.customerId);
  order.lines = getOrderLines(db, id);
  order.shipments = listShipmentsForOrder(db, id);
  order.events = toCamelAll<OrderEvent>(
    db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at DESC, id DESC').all(id) as Record<string, unknown>[],
    { json: ['data'] },
  );
  return order;
}

export function findOrderByNumber(db: Db, orderNumber: string): OrderDetail | undefined {
  const row = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber.trim().toUpperCase()) as { id: number } | undefined;
  return row ? getOrder(db, row.id) : undefined;
}

function getOrderLines(db: Db, orderId: number): OrderLine[] {
  const lines = toCamelAll<OrderLine>(
    db
      .prepare(
        `SELECT l.*, p.sku FROM order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.order_id = ? ORDER BY l.id`,
      )
      .all(orderId) as Record<string, unknown>[],
  );
  const picks = toCamelAll<BoxPickRow>(
    db
      .prepare(
        `SELECT b.id, b.order_line_id, b.product_id, b.quantity, p.sku, p.name AS product_name, p.brand, p.flavor, p.strength
         FROM box_picks b JOIN products p ON p.id = b.product_id
         WHERE b.order_line_id IN (SELECT id FROM order_lines WHERE order_id = ?) ORDER BY p.brand, p.name`,
      )
      .all(orderId) as Record<string, unknown>[],
  );
  for (const line of lines) line.picks = picks.filter((p) => p.orderLineId === line.id);
  return lines;
}

export function listOrders(
  db: Db,
  opts: { status?: OrderStatus | OrderStatus[]; customerId?: number; q?: string; limit?: number; offset?: number } = {},
): OrderListItem[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`o.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (opts.customerId != null) {
    where.push('o.customer_id = ?');
    params.push(opts.customerId);
  }
  if (opts.q) {
    const like = `%${opts.q.trim()}%`;
    where.push('(o.order_number LIKE ? OR o.external_ref LIKE ? OR o.ship_name LIKE ? OR c.email LIKE ? OR o.payment_ref LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT o.*, c.first_name || ' ' || c.last_name AS customer_name, c.email AS customer_email,
         (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count
       FROM orders o JOIN customers c ON c.id = o.customer_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.placed_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(opts.limit ?? 50, 500), opts.offset ?? 0) as Record<string, unknown>[];
  return toCamelAll<OrderListItem>(rows, { bool: ['ageVerified'] });
}

export function orderStatusCounts(db: Db): Record<OrderStatus, number> {
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all() as { status: string; n: number }[];
  for (const r of rows) if (isOrderStatus(r.status)) counts[r.status] = r.n;
  return counts;
}

export function markPaid(
  db: Db,
  id: number,
  input: { paymentRef?: string | null; paymentMethod?: string | null } = {},
  actor = 'system',
): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'paid');
    const ts = now();
    setStatus(db, id, 'paid', {
      payment_status: 'paid',
      paid_at: ts,
      payment_ref: input.paymentRef ?? order.paymentRef,
      payment_method: input.paymentMethod ?? order.paymentMethod,
    });
    addOrderEvent(db, id, 'paid', `Betalning registrerad${input.paymentRef ? ` (${input.paymentRef})` : ''}`, actor);
    return getOrder(db, id);
  });
}

/** Produkt-id som kunden fått i tidigare (ej avbrutna) ordrar – för att undvika upprepning. */
export function previouslySentProductIds(db: Db, customerId: number, excludeOrderId?: number): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT b.product_id AS id FROM box_picks b
         JOIN order_lines l ON l.id = b.order_line_id
         JOIN orders o ON o.id = l.order_id
       WHERE o.customer_id = ? AND o.status NOT IN ('cancelled') AND o.id != ?
       UNION
       SELECT DISTINCT l.product_id AS id FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE o.customer_id = ? AND o.status NOT IN ('cancelled') AND o.id != ? AND l.product_id IS NOT NULL`,
    )
    .all(customerId, excludeOrderId ?? -1, customerId, excludeOrderId ?? -1) as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Startar plockning: ordern går till "picking" och innehållet i eventuella
 * mystery-boxar föreslås automatiskt utifrån lager och kundens preferenser.
 */
export function startPicking(db: Db, id: number, actor = 'system', opts: { seed?: number } = {}): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'picking');
    if (order.paymentStatus !== 'paid') throw invalid('NOT_PAID', 'Ordern måste vara betald innan plockning');

    const candidates: PickCandidate[] = listProducts(db, { activeOnly: true, inStockOnly: true }).map((p) => ({
      id: p.id,
      brand: p.brand,
      flavor: p.flavor,
      strength: p.strength,
      available: availableStock(p),
    }));
    const sent = previouslySentProductIds(db, order.customerId, id);
    const seed = opts.seed ?? id * 7919 + candidates.length;

    let shortfall = 0;
    for (const line of order.lines) {
      if (line.kind !== 'mystery_box' || !line.boxSize) continue;
      const needed = line.boxSize * line.quantity;
      const picks = pickMysteryBox(candidates, {
        boxSize: needed,
        strength: line.boxStrength ?? order.customer.prefStrength,
        preferredFlavors: order.customer.prefFlavors,
        excludedFlavors: order.customer.excludedFlavors,
        previouslySent: sent,
        seed: seed + line.id,
      });
      replacePicks(db, line.id, picks);
      shortfall += needed - totalQuantity(picks);
      // Minska tillgängligheten för nästa rad i samma order.
      for (const pick of picks) {
        const c = candidates.find((x) => x.id === pick.productId);
        if (c) c.available -= pick.quantity;
      }
    }

    setStatus(db, id, 'picking');
    addOrderEvent(db, id, 'picking', 'Plockning påbörjad', actor);
    if (shortfall > 0) {
      addOrderEvent(db, id, 'warning', `Lagret räcker inte: ${shortfall} dosor saknas i förslaget – komplettera manuellt`, actor);
    }
    return getOrder(db, id);
  });
}

function replacePicks(db: Db, lineId: number, picks: BoxPick[]): void {
  db.prepare('DELETE FROM box_picks WHERE order_line_id = ?').run(lineId);
  const insert = db.prepare('INSERT INTO box_picks (order_line_id, product_id, quantity, created_at) VALUES (?, ?, ?, ?)');
  const ts = now();
  for (const p of picks) if (p.quantity > 0) insert.run(lineId, p.productId, p.quantity, ts);
}

/** Manuell justering av innehållet i en mystery-box (ersätter hela listan). */
export function setBoxPicks(db: Db, orderId: number, lineId: number, picks: BoxPick[], actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, orderId);
    const line = order.lines.find((l) => l.id === lineId);
    if (!line) throw notFound('Orderrad', lineId);
    if (line.kind !== 'mystery_box') throw invalid('NOT_A_BOX', 'Raden är ingen mystery-box');
    if (order.status !== 'picking') throw invalid('NOT_PICKING', 'Innehållet kan bara ändras medan ordern plockas');
    const merged = new Map<number, number>();
    for (const p of picks) {
      if (!Number.isInteger(p.quantity) || p.quantity < 0) throw invalid('INVALID_QUANTITY', 'Antal måste vara ett heltal ≥ 0');
      getProduct(db, p.productId);
      merged.set(p.productId, (merged.get(p.productId) ?? 0) + p.quantity);
    }
    replacePicks(db, lineId, [...merged].map(([productId, quantity]) => ({ productId, quantity })));
    addOrderEvent(db, orderId, 'picks_changed', `Innehållet i "${line.description}" ändrades manuellt`, actor);
    return getOrder(db, orderId);
  });
}

/** Avbryter plockningen och lägger tillbaka ordern i kön (picking → paid). */
export function cancelPicking(db: Db, id: number, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'paid');
    for (const line of order.lines) if (line.kind === 'mystery_box') replacePicks(db, line.id, []);
    setStatus(db, id, 'paid');
    addOrderEvent(db, id, 'picking_cancelled', 'Plockning avbruten – ordern ligger åter i kön', actor);
    return getOrder(db, id);
  });
}

/** Bekräftar packning: lagret dras och ordern blir "packed". */
export function pack(db: Db, id: number, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'packed');
    for (const line of order.lines) {
      if (line.kind === 'mystery_box') {
        const needed = (line.boxSize ?? 0) * line.quantity;
        const got = totalQuantity(line.picks);
        if (got !== needed) {
          throw invalid('BOX_INCOMPLETE', `"${line.description}" ska innehålla ${needed} dosor men ${got} är plockade`);
        }
        for (const pick of line.picks) consumeStock(db, pick.productId, pick.quantity, order.orderNumber);
      } else if (line.productId != null) {
        commitReserved(db, line.productId, line.quantity, order.orderNumber);
      }
    }
    setStatus(db, id, 'packed', { packed_at: now() });
    addOrderEvent(db, id, 'packed', 'Ordern är packad', actor);
    return getOrder(db, id);
  });
}

/** Öppnar en packad order igen (packed → picking) och lägger tillbaka lagret. */
export function reopenForPicking(db: Db, id: number, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'picking');
    returnStockToShelf(db, order, 'correction', 'Ordern öppnades igen');
    for (const line of order.lines) if (line.kind === 'product' && line.productId != null) reserveStock(db, line.productId, line.quantity, order.orderNumber);
    setStatus(db, id, 'picking', { packed_at: null });
    addOrderEvent(db, id, 'reopened', 'Ordern öppnades igen för plockning', actor);
    return getOrder(db, id);
  });
}

function returnStockToShelf(db: Db, order: OrderDetail, reason: 'return' | 'correction', note: string): void {
  for (const line of order.lines) {
    if (line.kind === 'mystery_box') {
      for (const pick of line.picks) adjustStock(db, pick.productId, pick.quantity, reason, { reference: order.orderNumber, note });
    } else if (line.productId != null) {
      adjustStock(db, line.productId, line.quantity, reason, { reference: order.orderNumber, note });
    }
  }
}

export function ship(db: Db, id: number, input: ShipmentInput, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'shipped');
    const weight = input.weightGrams ?? estimateWeightGrams(db, order);
    const shipment = createShipment(db, id, { ...input, weightGrams: weight });
    setStatus(db, id, 'shipped', { shipped_at: now() });
    addOrderEvent(
      db, id, 'shipped',
      `Skickad med ${input.carrier}${shipment.trackingNumber ? `, kolli ${shipment.trackingNumber}` : ''}`,
      actor, { shipmentId: shipment.id },
    );
    return getOrder(db, id);
  });
}

const PACKAGING_WEIGHT_GRAMS = 60;

export function estimateWeightGrams(db: Db, order: OrderDetail): number {
  let grams = PACKAGING_WEIGHT_GRAMS;
  for (const line of order.lines) {
    if (line.kind === 'mystery_box') {
      for (const pick of line.picks) grams += getProduct(db, pick.productId).weightGrams * pick.quantity;
    } else if (line.productId != null) {
      grams += getProduct(db, line.productId).weightGrams * line.quantity;
    }
  }
  return grams;
}

export function markDelivered(db: Db, id: number, actor = 'system', deliveredAt?: string): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'delivered');
    const ts = deliveredAt ?? now();
    setStatus(db, id, 'delivered', { delivered_at: ts });
    db.prepare("UPDATE shipments SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE order_id = ? AND status NOT IN ('delivered', 'returned')").run(ts, now(), id);
    addOrderEvent(db, id, 'delivered', 'Levererad till kund', actor);
    return getOrder(db, id);
  });
}

export function cancelOrder(db: Db, id: number, reason: string, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'cancelled');
    if (holdsReservation(order.status)) {
      for (const line of order.lines) {
        if (line.kind === 'product' && line.productId != null) releaseStock(db, line.productId, line.quantity);
        else replacePicks(db, line.id, []);
      }
    } else if (order.status === 'packed') {
      returnStockToShelf(db, order, 'correction', 'Ordern avbröts efter packning');
    }
    const paymentStatus: PaymentStatus = order.paymentStatus === 'paid' ? 'refund_due' : order.paymentStatus;
    setStatus(db, id, 'cancelled', { cancelled_at: now(), payment_status: paymentStatus });
    addOrderEvent(db, id, 'cancelled', `Avbruten: ${reason || 'ingen anledning angiven'}`, actor);
    if (paymentStatus === 'refund_due') addOrderEvent(db, id, 'refund_due', 'Ordern var betald – återbetalning krävs', actor);
    return getOrder(db, id);
  });
}

export function markReturned(
  db: Db,
  id: number,
  opts: { restock: boolean; reason?: string },
  actor = 'system',
): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    assertTransition(order, 'returned');
    if (opts.restock) returnStockToShelf(db, order, 'return', `Retur ${order.orderNumber}`);
    const paymentStatus: PaymentStatus = order.paymentStatus === 'paid' ? 'refund_due' : order.paymentStatus;
    setStatus(db, id, 'returned', { payment_status: paymentStatus });
    db.prepare("UPDATE shipments SET status = 'returned', updated_at = ? WHERE order_id = ? AND status NOT IN ('returned')").run(now(), id);
    addOrderEvent(db, id, 'returned', `Returnerad${opts.restock ? ' – lagret återfört' : ''}${opts.reason ? `: ${opts.reason}` : ''}`, actor);
    return getOrder(db, id);
  });
}

export function markRefunded(db: Db, id: number, actor = 'system'): OrderDetail {
  return transaction(db, () => {
    const order = getOrder(db, id);
    if (order.paymentStatus !== 'refund_due') throw invalid('NOT_REFUND_DUE', 'Ordern väntar inte på återbetalning');
    db.prepare("UPDATE orders SET payment_status = 'refunded', updated_at = ? WHERE id = ?").run(now(), id);
    addOrderEvent(db, id, 'refunded', 'Återbetalning genomförd', actor);
    return getOrder(db, id);
  });
}

export function setInternalNote(db: Db, id: number, note: string | null, actor = 'system'): OrderDetail {
  getOrder(db, id);
  db.prepare('UPDATE orders SET internal_note = ?, updated_at = ? WHERE id = ?').run(note?.trim() || null, now(), id);
  addOrderEvent(db, id, 'note', 'Intern anteckning uppdaterad', actor);
  return getOrder(db, id);
}
