import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv } from '../types.ts';
import { requireStaff, SESSION_COOKIE } from '../middleware.ts';
import { isProduction, config } from '../../config.ts';
import { AppError } from '../../domain/errors.ts';
import { isOrderStatus } from '../../domain/orderStatus.ts';
import { isStrength } from '../../domain/products.ts';
import { isCarrier, isShipmentStatus } from '../../domain/carriers.ts';
import { login, logout } from '../../services/auth.ts';
import { createCustomer, getCustomer, listCustomers, updateCustomer, type CustomerInput } from '../../services/customers.ts';
import { createProduct, getProduct, listProducts, updateProduct, type ProductInput } from '../../services/products.ts';
import { adjustStock, listMovements, type MovementReason } from '../../services/inventory.ts';
import {
  cancelOrder, cancelPicking, createOrder, getOrder, listOrders, markDelivered, markPaid, markRefunded, markReturned,
  orderStatusCounts, pack, reopenForPicking, setBoxPicks, setInternalNote, ship, startPicking, type OrderLineInput,
} from '../../services/orders.ts';
import { addShipmentEvent, listShipments, updateShipment } from '../../services/shipments.ts';
import { idParam } from '../validate.ts';
import * as v from './views.ts';

type Form = Record<string, string | File | (string | File)[]>;
const str = (form: Form, key: string): string => {
  const raw = form[key];
  return typeof raw === 'string' ? raw.trim() : '';
};
const opt = (form: Form, key: string): string | null => str(form, key) || null;
const num = (form: Form, key: string): number | null => {
  const s = str(form, key).replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const list = (form: Form, key: string): string[] =>
  str(form, key).split(',').map((s) => s.trim()).filter(Boolean);

function redirect(c: Context<AppEnv>, path: string, flash?: { msg?: string; err?: string }) {
  const url = new URL(path, 'http://x');
  if (flash?.msg) url.searchParams.set('msg', flash.msg);
  if (flash?.err) url.searchParams.set('err', flash.err);
  return c.redirect(url.pathname + url.search);
}

const flash = (c: Context<AppEnv>) => ({ msg: c.req.query('msg') || undefined, err: c.req.query('err') || undefined });

/** Kör en åtgärd och skickar tillbaka användaren med fel-/bekräftelsemeddelande. */
async function attempt(c: Context<AppEnv>, backTo: string, okMsg: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    return redirect(c, backTo, { msg: okMsg });
  } catch (err) {
    if (err instanceof AppError) return redirect(c, backTo, { err: err.message });
    throw err;
  }
}

function safeNext(raw: string | undefined): string {
  return raw && raw.startsWith('/admin') && !raw.startsWith('//') ? raw : '/admin';
}

export const admin = new Hono<AppEnv>();

admin.get('/login', (c) => {
  if (c.get('staff')) return c.redirect('/admin');
  return c.html(v.loginPage({ next: c.req.query('next') }));
});

admin.post('/login', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  const sessionId = login(c.get('db'), str(form, 'email'), str(form, 'password'));
  if (!sessionId) return c.html(v.loginPage({ error: 'Fel e-post eller lösenord', next: str(form, 'next') }), 401);
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true, sameSite: 'Lax', path: '/', secure: isProduction(), maxAge: config.sessionTtlHours * 3600,
  });
  return c.redirect(safeNext(str(form, 'next')));
});

admin.post('/logout', (c) => {
  logout(c.get('db'), c.req.header('cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/admin/login');
});

admin.use('*', requireStaff);

/* ---------- Översikt ---------- */

admin.get('/', (c) => {
  const db = c.get('db');
  const staff = c.get('staff')!;
  const counts = orderStatusCounts(db);
  const queue = listOrders(db, { status: ['paid', 'picking'], limit: 15 });
  const lowStock = listProducts(db, { activeOnly: true, lowStockOnly: true });
  const refundDue = listOrders(db, { limit: 200 }).filter((o) => o.paymentStatus === 'refund_due');
  const unpaid = listOrders(db, { status: 'pending', limit: 10 });
  return c.html(v.dashboardPage(staff, { counts, queue, lowStock, refundDue, unpaid }));
});

/* ---------- Ordrar ---------- */

admin.get('/orders', (c) => {
  const db = c.get('db');
  const status = c.req.query('status');
  const refund = c.req.query('refund');
  const q = c.req.query('q') || undefined;
  let orders = listOrders(db, { status: isOrderStatus(status) ? status : undefined, q, limit: 200 });
  if (refund === 'due') orders = orders.filter((o) => o.paymentStatus === 'refund_due');
  return c.html(v.ordersPage(c.get('staff')!, { orders, status: isOrderStatus(status) ? status : undefined, q, refund, ...flash(c) }));
});

admin.get('/orders/new', (c) => {
  const db = c.get('db');
  return c.html(v.newOrderPage(c.get('staff')!, listCustomers(db, { limit: 500 }), listProducts(db, { activeOnly: true }), flash(c)));
});

admin.post('/orders/new', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  try {
    const lines: OrderLineInput[] = [];
    const boxSize = num(form, 'boxSize');
    if (boxSize) {
      const strength = str(form, 'boxStrength');
      lines.push({ kind: 'mystery_box', boxSize, quantity: num(form, 'boxQuantity') ?? 1, strength: isStrength(strength) ? strength : null });
    }
    for (const row of str(form, 'productLines').split('\n')) {
      const [sku, qty] = row.trim().split(/\s+/);
      if (!sku) continue;
      lines.push({ kind: 'product', sku, quantity: Number(qty ?? 1) });
    }
    const customerId = num(form, 'customerId');
    if (!customerId) throw new AppError(422, 'MISSING_CUSTOMER', 'Välj en kund');
    const order = createOrder(c.get('db'), {
      customerId,
      lines,
      channel: 'manual',
      paymentStatus: str(form, 'paymentStatus') === 'paid' ? 'paid' : 'unpaid',
      paymentMethod: opt(form, 'paymentMethod'),
      customerNote: opt(form, 'customerNote'),
    }, c.get('actor'));
    return redirect(c, `/admin/orders/${order.id}`, { msg: `Order ${order.orderNumber} skapad` });
  } catch (err) {
    if (err instanceof AppError) return redirect(c, '/admin/orders/new', { err: err.message });
    throw err;
  }
});

admin.get('/orders/:id', (c) => {
  const db = c.get('db');
  const order = getOrder(db, idParam(c));
  const products = order.status === 'picking' ? listProducts(db, { activeOnly: true, inStockOnly: true }) : [];
  return c.html(v.orderPage(c.get('staff')!, order, products, flash(c)));
});

admin.get('/orders/:id/packslip', (c) => c.html(v.packSlipPage(getOrder(c.get('db'), idParam(c)))));

admin.post('/orders/:id/note', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/orders/${id}`, 'Anteckning sparad', () => {
    setInternalNote(c.get('db'), id, opt(form, 'internalNote'), c.get('actor'));
  });
});

admin.post('/orders/:id/lines/:lineId/picks', async (c) => {
  const id = idParam(c);
  const lineId = idParam(c, 'lineId');
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/orders/${id}`, 'Boxinnehållet uppdaterat', () => {
    const picks: { productId: number; quantity: number }[] = [];
    for (const [key, value] of Object.entries(form)) {
      const m = key.match(/^pick_(\d+)$/);
      if (m && typeof value === 'string') picks.push({ productId: Number(m[1]), quantity: Number(value) || 0 });
    }
    const addId = num(form, 'addProductId');
    if (addId) picks.push({ productId: addId, quantity: num(form, 'addQuantity') ?? 1 });
    setBoxPicks(c.get('db'), id, lineId, picks, c.get('actor'));
  });
});

admin.post('/orders/:id/actions/:action', async (c) => {
  const id = idParam(c);
  const action = c.req.param('action');
  const form = (await c.req.parseBody().catch(() => ({}))) as Form;
  const db = c.get('db');
  const actor = c.get('actor');
  const back = `/admin/orders/${id}`;
  const messages: Record<string, string> = {
    pay: 'Ordern markerad som betald', pick: 'Plockning startad – boxinnehåll föreslaget', 'cancel-picking': 'Plockning avbruten',
    pack: 'Ordern packad och lagret uppdaterat', reopen: 'Ordern öppnad igen', ship: 'Ordern registrerad som skickad',
    deliver: 'Ordern markerad som levererad', cancel: 'Ordern avbruten', return: 'Retur registrerad', refund: 'Återbetalning registrerad',
  };
  return attempt(c, back, messages[action] ?? 'Klart', () => {
    switch (action) {
      case 'pay': return void markPaid(db, id, { paymentRef: opt(form, 'paymentRef') }, actor);
      case 'pick': return void startPicking(db, id, actor, { seed: Date.now() % 100_000 });
      case 'cancel-picking': return void cancelPicking(db, id, actor);
      case 'pack': return void pack(db, id, actor);
      case 'reopen': return void reopenForPicking(db, id, actor);
      case 'ship': {
        const carrier = str(form, 'carrier');
        if (!isCarrier(carrier)) throw new AppError(422, 'INVALID_CARRIER', 'Välj en transportör');
        return void ship(db, id, {
          carrier, service: opt(form, 'service'), trackingNumber: opt(form, 'trackingNumber'),
          pickupPoint: opt(form, 'pickupPoint'), weightGrams: num(form, 'weightGrams'),
        }, actor);
      }
      case 'deliver': return void markDelivered(db, id, actor);
      case 'cancel': return void cancelOrder(db, id, str(form, 'reason'), actor);
      case 'return': return void markReturned(db, id, { restock: str(form, 'restock') === '1', reason: opt(form, 'reason') ?? undefined }, actor);
      case 'refund': return void markRefunded(db, id, actor);
      default: throw new AppError(404, 'NOT_FOUND', `Okänd åtgärd: ${action}`);
    }
  });
});

/* ---------- Kunder ---------- */

function customerInputFromForm(form: Form): CustomerInput {
  const strength = str(form, 'prefStrength');
  return {
    email: str(form, 'email'), firstName: str(form, 'firstName'), lastName: str(form, 'lastName'), phone: opt(form, 'phone'),
    birthDate: str(form, 'birthDate'), street: opt(form, 'street'), postalCode: opt(form, 'postalCode'), city: opt(form, 'city'),
    country: str(form, 'country') || 'SE', marketingConsent: str(form, 'marketingConsent') === '1',
    prefStrength: isStrength(strength) ? strength : null, prefFlavors: list(form, 'prefFlavors'), excludedFlavors: list(form, 'excludedFlavors'),
    notes: opt(form, 'notes'),
  };
}

admin.get('/customers', (c) => {
  const q = c.req.query('q') || undefined;
  return c.html(v.customersPage(c.get('staff')!, { customers: listCustomers(c.get('db'), { q, limit: 200 }), q, ...flash(c) }));
});

admin.get('/customers/new', (c) => c.html(v.newCustomerPage(c.get('staff')!, flash(c))));

admin.post('/customers/new', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  try {
    const customer = createCustomer(c.get('db'), customerInputFromForm(form));
    return redirect(c, `/admin/customers/${customer.id}`, { msg: 'Kund skapad' });
  } catch (err) {
    if (err instanceof AppError) return c.html(v.newCustomerPage(c.get('staff')!, { err: err.message, values: customerInputFromForm(form) as never }), err.status as 400);
    throw err;
  }
});

admin.get('/customers/:id', (c) => {
  const db = c.get('db');
  const id = idParam(c);
  return c.html(v.customerPage(c.get('staff')!, getCustomer(db, id), listOrders(db, { customerId: id, limit: 100 }), flash(c)));
});

admin.post('/customers/:id', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/customers/${id}`, 'Kunduppgifter sparade', () => {
    const status = str(form, 'status');
    updateCustomer(c.get('db'), id, { ...customerInputFromForm(form), status: status === 'blocked' ? 'blocked' : 'active' });
  });
});

/* ---------- Produkter ---------- */

function productInputFromForm(form: Form): ProductInput {
  const strength = str(form, 'strength');
  const format = str(form, 'format');
  return {
    sku: str(form, 'sku'), name: str(form, 'name'), brand: str(form, 'brand'), flavor: str(form, 'flavor'),
    strength: isStrength(strength) ? strength : 'medium', nicotineMg: num(form, 'nicotineMg'),
    format: (['original', 'slim', 'mini', 'large'] as const).find((f) => f === format) ?? 'slim',
    priceOre: Math.round((num(form, 'priceKr') ?? 0) * 100), vatRate: num(form, 'vatRate') ?? config.vatRate,
    weightGrams: num(form, 'weightGrams') ?? 20, active: str(form, 'active') === '1',
  };
}

admin.get('/products', (c) => {
  const q = c.req.query('q') || undefined;
  const lowStock = c.req.query('lowStock') === '1';
  return c.html(v.productsPage(c.get('staff')!, { products: listProducts(c.get('db'), { q, lowStockOnly: lowStock }), q, lowStock, ...flash(c) }));
});

admin.get('/products/new', (c) => c.html(v.newProductPage(c.get('staff')!, flash(c))));

admin.post('/products/new', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  try {
    const product = createProduct(c.get('db'), productInputFromForm(form));
    return redirect(c, `/admin/products/${product.id}`, { msg: 'Produkt skapad' });
  } catch (err) {
    if (err instanceof AppError) return redirect(c, '/admin/products/new', { err: err.message });
    throw err;
  }
});

admin.get('/products/:id', (c) => {
  const db = c.get('db');
  const id = idParam(c);
  return c.html(v.productPage(c.get('staff')!, getProduct(db, id), listMovements(db, id), flash(c)));
});

admin.post('/products/:id', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/products/${id}`, 'Produkt sparad', () => {
    updateProduct(c.get('db'), id, productInputFromForm(form));
  });
});

admin.post('/products/:id/stock', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  const back = c.req.header('referer')?.includes('/admin/products/') ? `/admin/products/${id}` : '/admin/products';
  return attempt(c, back, 'Lagersaldo uppdaterat', () => {
    const reason = str(form, 'reason') as MovementReason;
    const allowed: MovementReason[] = ['purchase', 'adjustment', 'return', 'correction'];
    adjustStock(c.get('db'), id, num(form, 'delta') ?? 0, allowed.includes(reason) ? reason : 'adjustment', {
      note: opt(form, 'note') ?? undefined, reference: c.get('actor'),
    });
  });
});

/* ---------- Försändelser ---------- */

admin.get('/shipments', (c) => {
  const status = c.req.query('status');
  const q = c.req.query('q') || undefined;
  const shipments = listShipments(c.get('db'), { status: isShipmentStatus(status) ? status : undefined, q, limit: 200 });
  return c.html(v.shipmentsPage(c.get('staff')!, { shipments, status: isShipmentStatus(status) ? status : undefined, q, ...flash(c) }));
});

admin.post('/shipments/:id', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, '/admin/shipments', 'Försändelse uppdaterad', () => {
    updateShipment(c.get('db'), id, { trackingNumber: opt(form, 'trackingNumber') });
  });
});

admin.post('/shipments/:id/events', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, '/admin/shipments', 'Händelse registrerad', () => {
    const status = str(form, 'status');
    if (!isShipmentStatus(status)) throw new AppError(422, 'INVALID_STATUS', 'Ogiltig status');
    addShipmentEvent(c.get('db'), id, { status, location: opt(form, 'location') }, c.get('actor'));
  });
});
