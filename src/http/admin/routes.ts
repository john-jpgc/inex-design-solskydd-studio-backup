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
import { addShipmentEvent, getShipment, listShipments, updateShipment } from '../../services/shipments.ts';
import { createLabelForShipment, labelProviderStatus } from '../../services/labels.ts';
import {
  assignWaves, cancelSubscription, createSubscription, getSubscription, listSubscriptions, pauseSubscription,
  renewDueSubscriptions, renewSubscription, resumeSubscription, subscriptionCounts, updateSubscription, waveSummary,
} from '../../services/subscriptions.ts';
import {
  archiveEdition, createEdition, editionForecast, getEdition, listEditions, lockEdition,
  setEditionItem, unlockEdition, updateEdition,
} from '../../services/editions.ts';
import { editionReport, editionReportCsv, productHistory } from '../../services/reports.ts';
import { listComments, listCustomerRatings } from '../../services/ratings.ts';
import { createRetailer, deleteRetailerLink, listAllLinks, listRetailers, setRetailerLink } from '../../services/retailers.ts';
import { createSupplier, listSuppliers } from '../../services/suppliers.ts';
import * as ev from './editionViews.ts';
import * as rv from './retailViews.ts';
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
  const period = new Date().toISOString().slice(0, 7);
  const currentEdition = listEditions(db).find((e) => e.period === period);
  return c.html(
    v.dashboardPage(staff, {
      counts, queue, lowStock, refundDue, unpaid,
      subs: subscriptionCounts(db), labelProvider: labelProviderStatus(),
      currentEdition, waves: waveSummary(db),
    }),
  );
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
  return c.html(v.orderPage(c.get('staff')!, order, products, { ...flash(c), labelProvider: labelProviderStatus() }));
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
        const shipped = ship(db, id, {
          carrier, service: opt(form, 'service'), trackingNumber: opt(form, 'trackingNumber'),
          pickupPoint: opt(form, 'pickupPoint'), weightGrams: num(form, 'weightGrams'),
        }, actor);
        const shipment = shipped.shipments[0];
        if (shipment && !shipment.trackingNumber && labelProviderStatus().configured) {
          return createLabelForShipment(db, shipment.id, actor).then(() => undefined);
        }
        return;
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
  return c.html(
    v.customerPage(
      c.get('staff')!, getCustomer(db, id), listOrders(db, { customerId: id, limit: 100 }),
      listSubscriptions(db, { customerId: id }), listCustomerRatings(db, id), flash(c),
    ),
  );
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
    supplierId: num(form, 'supplierId'),
  };
}

admin.get('/products', (c) => {
  const q = c.req.query('q') || undefined;
  const lowStock = c.req.query('lowStock') === '1';
  const db = c.get('db');
  const supplierNames = new Map(listSuppliers(db).map((s) => [s.id, s.name]));
  return c.html(v.productsPage(c.get('staff')!, { products: listProducts(db, { q, lowStockOnly: lowStock }), supplierNames, q, lowStock, ...flash(c) }));
});

admin.get('/products/new', (c) => c.html(v.newProductPage(c.get('staff')!, listSuppliers(c.get('db')), flash(c))));

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
  return c.html(v.productPage(c.get('staff')!, getProduct(db, id), listMovements(db, id), listSuppliers(db), productHistory(db, id), flash(c)));
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

/* ---------- Etiketter ---------- */

admin.post('/shipments/:id/label', async (c) => {
  const id = idParam(c);
  const shipment = getShipment(c.get('db'), id);
  return attempt(c, `/admin/orders/${shipment.orderId}`, 'Etikett skapad', async () => {
    await createLabelForShipment(c.get('db'), id, c.get('actor'));
  });
});

/* ---------- Prenumerationer ---------- */

admin.get('/subscriptions', (c) => {
  const status = c.req.query('status');
  const q = c.req.query('q') || undefined;
  const valid = status === 'active' || status === 'paused' || status === 'cancelled' ? status : undefined;
  const db = c.get('db');
  return c.html(
    v.subscriptionsPage(c.get('staff')!, {
      subscriptions: listSubscriptions(db, { status: valid, q, limit: 500 }),
      waves: waveSummary(db), waveMode: config.waves.mode, status: valid, q, ...flash(c),
    }),
  );
});

admin.post('/subscriptions/renew-due', (c) => {
  const result = renewDueSubscriptions(c.get('db'), undefined, c.get('actor'));
  const msg = `${result.created.length} order(s) skapade${result.failed.length ? `, ${result.failed.length} misslyckades` : ''}`;
  return redirect(c, '/admin/subscriptions', result.failed.length ? { err: msg } : { msg });
});

admin.get('/subscriptions/:id', (c) => {
  const db = c.get('db');
  const id = idParam(c);
  const sub = getSubscription(db, id);
  const orders = listOrders(db, { customerId: sub.customerId, limit: 200 }).filter((o) => o.subscriptionId === id);
  return c.html(v.subscriptionPage(c.get('staff')!, sub, getCustomer(db, sub.customerId), orders, flash(c)));
});

admin.post('/subscriptions/:id', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/subscriptions/${id}`, 'Prenumerationen sparad', () => {
    const strength = str(form, 'strength');
    const nextDate = str(form, 'nextRenewalDate');
    const priceKr = num(form, 'priceKr');
    updateSubscription(c.get('db'), id, {
      boxSize: num(form, 'boxSize') ?? undefined, quantity: num(form, 'quantity') ?? undefined,
      strength: isStrength(strength) ? strength : null, priceOre: priceKr != null ? Math.round(priceKr * 100) : undefined,
      intervalMonths: num(form, 'intervalMonths') ?? undefined, wave: num(form, 'wave') ?? undefined,
      nextRenewalAt: nextDate ? new Date(`${nextDate}T08:00:00Z`).toISOString() : undefined,
      paymentMethod: opt(form, 'paymentMethod'), externalRef: opt(form, 'externalRef'), notes: opt(form, 'notes'),
    });
  });
});

admin.post('/subscriptions/:id/actions/:action', (c) => {
  const id = idParam(c);
  const action = c.req.param('action');
  const db = c.get('db');
  const messages: Record<string, string> = { renew: 'Månadens order skapad', pause: 'Prenumerationen pausad', resume: 'Prenumerationen återupptagen', cancel: 'Prenumerationen avslutad' };
  return attempt(c, `/admin/subscriptions/${id}`, messages[action] ?? 'Klart', () => {
    switch (action) {
      case 'renew': {
        const r = renewSubscription(db, id, {}, c.get('actor'));
        if (!r.created) throw new AppError(409, 'ALREADY_RENEWED', `Perioden har redan en order: ${r.order.orderNumber}`);
        return;
      }
      case 'pause': return void pauseSubscription(db, id);
      case 'resume': return void resumeSubscription(db, id);
      case 'cancel': return void cancelSubscription(db, id);
      default: throw new AppError(404, 'NOT_FOUND', `Okänd åtgärd: ${action}`);
    }
  });
});

admin.post('/customers/:id/subscriptions', async (c) => {
  const customerId = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/customers/${customerId}`, 'Prenumeration skapad', () => {
    const strength = str(form, 'strength');
    const priceKr = num(form, 'priceKr');
    const startDate = str(form, 'startDate');
    createSubscription(c.get('db'), {
      customerId, boxSize: num(form, 'boxSize') ?? undefined, quantity: num(form, 'quantity') ?? undefined,
      strength: isStrength(strength) ? strength : null, priceOre: priceKr != null ? Math.round(priceKr * 100) : undefined,
      startAt: startDate ? new Date(`${startDate}T08:00:00Z`).toISOString() : undefined, paymentMethod: opt(form, 'paymentMethod'),
    }, c.get('actor'));
  });
});

/* ---------- Utskicksvågor ---------- */

admin.post('/waves/assign', (c) =>
  attempt(c, '/admin/subscriptions', 'Prenumeranterna fördelades i vågor', () => {
    const result = assignWaves(c.get('db'));
    if (result.updated === 0) throw new AppError(409, 'NO_CHANGE', 'Inga prenumerationer behövde flyttas');
  }));

/* ---------- Månadsboxar ---------- */

function suggestedPeriod(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
}

admin.get('/editions', (c) =>
  c.html(ev.editionsPage(c.get('staff')!, { editions: listEditions(c.get('db')), suggestedPeriod: suggestedPeriod(), ...flash(c) })));

admin.post('/editions', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  try {
    const edition = createEdition(c.get('db'), { period: str(form, 'period'), name: opt(form, 'name') ?? undefined, description: opt(form, 'description') });
    return redirect(c, `/admin/editions/${edition.id}`, { msg: 'Boxen skapad – lägg till innehållet' });
  } catch (err) {
    if (err instanceof AppError) return redirect(c, '/admin/editions', { err: err.message });
    throw err;
  }
});

admin.get('/editions/:id', (c) => {
  const db = c.get('db');
  const id = idParam(c);
  const edition = getEdition(db, id);
  const chosen = new Set(edition.items.map((i) => i.productId));
  const products = listProducts(db, { activeOnly: true }).filter((p) => !chosen.has(p.id));
  return c.html(ev.editionPage(c.get('staff')!, edition, products, editionForecast(db, id), flash(c)));
});

admin.post('/editions/:id', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/editions/${id}`, 'Boxen sparad', () => {
    updateEdition(c.get('db'), id, { name: str(form, 'name'), description: opt(form, 'description') });
  });
});

admin.post('/editions/:id/items', async (c) => {
  const id = idParam(c);
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, `/admin/editions/${id}`, 'Innehållet uppdaterat', () => {
    const productId = num(form, 'productId');
    if (!productId) throw new AppError(422, 'MISSING_PRODUCT', 'Välj en produkt');
    setEditionItem(c.get('db'), id, productId, num(form, 'quantity') ?? 0);
  });
});

admin.post('/editions/:id/lock', (c) => {
  const id = idParam(c);
  return attempt(c, `/admin/editions/${id}`, 'Boxen är låst och kan plockas', () => void lockEdition(c.get('db'), id));
});

admin.post('/editions/:id/unlock', (c) => {
  const id = idParam(c);
  return attempt(c, `/admin/editions/${id}`, 'Boxen är upplåst för ändring', () => void unlockEdition(c.get('db'), id));
});

admin.post('/editions/:id/archive', (c) => {
  const id = idParam(c);
  return attempt(c, '/admin/editions', 'Boxen arkiverad', () => void archiveEdition(c.get('db'), id));
});

admin.get('/editions/:id/report', (c) => {
  const db = c.get('db');
  const id = idParam(c);
  const supplierId = Number(c.req.query('supplierId')) || undefined;
  const report = editionReport(db, id, { supplierId, includeComments: false });
  return c.html(ev.editionReportPage(c.get('staff')!, report, listSuppliers(db), listComments(db, { editionId: id }), { supplierId, ...flash(c) }));
});

admin.get('/editions/:id/report.csv', (c) => {
  const db = c.get('db');
  const id = idParam(c);
  const edition = getEdition(db, id);
  const supplierId = Number(c.req.query('supplierId')) || undefined;
  return c.body(editionReportCsv(db, id, { supplierId }), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="mysterysnus-${edition.period}.csv"`,
  });
});

/* ---------- Återförsäljare och leverantörer ---------- */

admin.get('/retailers', (c) => {
  const db = c.get('db');
  return c.html(
    rv.retailersPage(c.get('staff')!, {
      retailers: listRetailers(db), links: listAllLinks(db), products: listProducts(db, { activeOnly: true }),
      publicBaseUrl: config.publicBaseUrl, ...flash(c),
    }),
  );
});

admin.post('/retailers', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, '/admin/retailers', 'Återförsäljaren tillagd', () => {
    createRetailer(c.get('db'), { name: str(form, 'name'), website: opt(form, 'website') });
  });
});

admin.post('/retailers/links', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, '/admin/retailers', 'Köplänken sparad', () => {
    const retailerId = num(form, 'retailerId');
    const productId = num(form, 'productId');
    if (!retailerId || !productId) throw new AppError(422, 'MISSING_FIELDS', 'Välj både butik och produkt');
    const priceKr = num(form, 'priceKr');
    setRetailerLink(c.get('db'), { retailerId, productId, url: str(form, 'url'), priceOre: priceKr != null ? Math.round(priceKr * 100) : null });
  });
});

admin.post('/retailers/links/:id/delete', (c) => {
  const id = idParam(c);
  return attempt(c, '/admin/retailers', 'Köplänken borttagen', () => deleteRetailerLink(c.get('db'), id));
});

admin.get('/suppliers', (c) => {
  const db = c.get('db');
  const products = listProducts(db);
  const suppliers = listSuppliers(db).map((s) => ({ ...s, productCount: products.filter((p) => p.supplierId === s.id).length }));
  return c.html(rv.suppliersPage(c.get('staff')!, { suppliers, ...flash(c) }));
});

admin.post('/suppliers', async (c) => {
  const form = (await c.req.parseBody()) as Form;
  return attempt(c, '/admin/suppliers', 'Leverantören tillagd', () => {
    createSupplier(c.get('db'), { name: str(form, 'name'), contactName: opt(form, 'contactName'), contactEmail: opt(form, 'contactEmail') });
  });
});
