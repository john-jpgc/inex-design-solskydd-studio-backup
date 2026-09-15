import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatSek } from '../../domain/money.ts';
import { allowedTransitions, ORDER_STATUSES, STATUS_LABELS, type OrderStatus } from '../../domain/orderStatus.ts';
import { STRENGTH_LABELS, STRENGTHS, FORMATS } from '../../domain/products.ts';
import { CARRIER_LABELS, CARRIERS, SHIPMENT_STATUS_LABELS, SHIPMENT_STATUSES, type ShipmentStatus } from '../../domain/carriers.ts';
import type { StaffUser } from '../../services/auth.ts';
import { ROLE_LABELS } from '../../services/auth.ts';
import type { Customer, CustomerListItem } from '../../services/customers.ts';
import { fullName } from '../../services/customers.ts';
import { availableStock, isLowStock, type Product } from '../../services/products.ts';
import type { StockMovement } from '../../services/inventory.ts';
import { PAYMENT_STATUS_LABELS, type OrderDetail, type OrderListItem } from '../../services/orders.ts';
import type { ShipmentDetail, ShipmentListItem } from '../../services/shipments.ts';
import type { EditionListItem } from '../../services/editions.ts';
import { periodLabel } from '../../services/editions.ts';
import { SENTIMENT_LABELS } from '../../domain/ratings.ts';
import type { CustomerRatingHistoryRow } from '../../services/ratings.ts';
import type { Supplier } from '../../services/suppliers.ts';
import type { WaveSummary } from '../../services/subscriptions.ts';
import type { ProductHistoryRow } from '../../services/reports.ts';
import { SUBSCRIPTION_STATUS_LABELS, type Subscription, type SubscriptionListItem, type SubscriptionStatus } from '../../services/subscriptions.ts';
import { config } from '../../config.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e2dc;--accent:#0f6b4f;--accent-ink:#fff;--warn:#b45309;--danger:#b91c1c;--info:#1d4ed8}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.45}
a{color:var(--accent)}header{background:#14342b;color:#fff;padding:8px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;min-height:56px}
header .brand{font-weight:700;letter-spacing:.3px;color:#fff;text-decoration:none;font-size:16px;white-space:nowrap}
header nav{display:flex;flex-wrap:wrap;gap:4px 14px}header nav a{color:#cfe3da;text-decoration:none;font-size:14px;white-space:nowrap}header nav a.active,header nav a:hover{color:#fff}
header .user{margin-left:auto;color:#cfe3da;font-size:13px;display:flex;gap:12px;align-items:center;white-space:nowrap}header .user button{background:transparent;border:1px solid #4f7d6d;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer}
@media (max-width:900px){header .user{margin-left:0;width:100%}}
main{max-width:1200px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 16px}h2{font-size:17px;margin:24px 0 8px}h3{font-size:15px;margin:16px 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}.grid{display:grid;gap:16px}.grid.cols-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}.grid.cols-4{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.stat{display:block;text-decoration:none;color:inherit}.stat .n{font-size:28px;font-weight:700}.stat .l{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td form.row{flex-wrap:nowrap}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#e8e6e0;color:#3d3d39;white-space:nowrap}
.badge.pending{background:#fef3c7;color:#92400e}.badge.paid{background:#dbeafe;color:#1e40af}.badge.picking{background:#ede9fe;color:#5b21b6}.badge.packed{background:#e0f2fe;color:#075985}.badge.shipped{background:#d1fae5;color:#065f46}.badge.delivered{background:#bbf7d0;color:#14532d}.badge.cancelled{background:#fee2e2;color:#991b1b}.badge.returned{background:#fde68a;color:#78350f}
.badge.in_transit{background:#d1fae5;color:#065f46}.badge.at_pickup_point{background:#e0f2fe;color:#075985}.badge.failed{background:#fee2e2;color:#991b1b}.badge.refund_due{background:#fee2e2;color:#991b1b}.badge.refunded{background:#e8e6e0}.badge.unpaid{background:#fef3c7;color:#92400e}
.badge.low{background:#fee2e2;color:#991b1b}.badge.active{background:#bbf7d0;color:#14532d}.badge.paused{background:#fef3c7;color:#92400e}.badge.label_printed{background:#e0f2fe;color:#075985}.badge.created{background:#e8e6e0}
form.inline{display:inline}button,.btn{background:var(--accent);color:var(--accent-ink);border:0;padding:7px 14px;border-radius:7px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.3}button.secondary,.btn.secondary{background:#e8e6e0;color:var(--ink)}button.danger{background:var(--danger)}button.warn{background:var(--warn)}button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;padding:7px 9px;border:1px solid #c9c7c0;border-radius:7px;background:#fff;width:100%}textarea{min-height:70px}label{display:block;font-size:13px;color:var(--muted);margin-bottom:3px}.field{margin-bottom:10px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.row .field{flex:1;min-width:120px;margin-bottom:0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px}.flash.ok{background:#d1fae5;color:#065f46}.flash.err{background:#fee2e2;color:#991b1b}
.muted{color:var(--muted)}.small{font-size:13px}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}.right{text-align:right}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}.filters a{padding:4px 10px;border-radius:999px;background:#e8e6e0;color:var(--ink);text-decoration:none;font-size:13px}.filters a.active{background:var(--accent);color:#fff}.filters form{display:flex;gap:6px;margin-left:auto}.filters input{width:220px}
.timeline{list-style:none;padding:0;margin:0}.timeline li{padding:6px 0;border-bottom:1px dashed var(--line);font-size:13px}.timeline .t{color:var(--muted);margin-right:8px;font-variant-numeric:tabular-nums}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--muted);font-size:13px}dd{margin:0}
.login{max-width:380px;margin:80px auto}
@media print{header,.no-print{display:none}body{background:#fff}main{padding:0;max-width:none}.card{border:0;padding:0}}
`;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' });
}

export function statusBadge(status: OrderStatus): Html {
  return html`<span class="badge ${status}">${STATUS_LABELS[status]}</span>`;
}

export function shipmentBadge(status: ShipmentStatus): Html {
  return html`<span class="badge ${status}">${SHIPMENT_STATUS_LABELS[status]}</span>`;
}

const NAV: [string, string][] = [
  ['/admin', 'Översikt'],
  ['/admin/editions', 'Månadsboxar'],
  ['/admin/orders', 'Ordrar'],
  ['/admin/subscriptions', 'Prenumerationer'],
  ['/admin/shipments', 'Försändelser'],
  ['/admin/products', 'Produkter & lager'],
  ['/admin/customers', 'Kunder'],
  ['/admin/retailers', 'Återförsäljare'],
];

export function layout(
  staff: StaffUser | undefined,
  title: string,
  body: Html,
  opts: { path?: string; msg?: string; err?: string } = {},
): Html {
  const path = opts.path ?? '';
  return html`<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} – Mysterysnus OMS</title>
<style>${raw(CSS)}</style>
</head>
<body>
<header>
  <a class="brand" href="/admin">Mysterysnus OMS</a>
  <nav>${NAV.map(([href, label]) => html`<a href="${href}" class="${path === href || (href !== '/admin' && path.startsWith(href)) ? 'active' : ''}">${label}</a>`)}</nav>
  ${staff ? html`<div class="user"><span>${staff.name} · ${ROLE_LABELS[staff.role]}</span><form method="post" action="/admin/logout"><button type="submit">Logga ut</button></form></div>` : ''}
</header>
<main>
${opts.msg ? html`<div class="flash ok">${opts.msg}</div>` : ''}
${opts.err ? html`<div class="flash err">${opts.err}</div>` : ''}
${body}
</main>
</body>
</html>`;
}

export function errorPage(staff: StaffUser | undefined, status: number, message: string): Html {
  return layout(staff, `Fel ${status}`, html`<h1>${status === 404 ? 'Hittades inte' : 'Något gick fel'}</h1><div class="card"><p>${message}</p><p><a href="javascript:history.back()">← Tillbaka</a></p></div>`);
}

export function loginPage(opts: { error?: string; next?: string } = {}): Html {
  return html`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Logga in – Mysterysnus OMS</title><style>${raw(CSS)}</style></head>
<body><main><div class="login card"><h1>Mysterysnus OMS</h1>
${opts.error ? html`<div class="flash err">${opts.error}</div>` : ''}
<form method="post" action="/admin/login">
<input type="hidden" name="next" value="${opts.next ?? ''}">
<div class="field"><label>E-post</label><input type="email" name="email" required autofocus autocomplete="username"></div>
<div class="field"><label>Lösenord</label><input type="password" name="password" required autocomplete="current-password"></div>
<button type="submit">Logga in</button>
</form></div></main></body></html>`;
}

/* ---------- Översikt ---------- */

export function dashboardPage(
  staff: StaffUser,
  data: { counts: Record<OrderStatus, number>; queue: OrderListItem[]; lowStock: Product[]; refundDue: OrderListItem[]; unpaid: OrderListItem[]; subs: { active: number; paused: number; dueWithin7Days: number }; labelProvider: { id: string; name: string; configured: boolean }; currentEdition?: EditionListItem; waves: WaveSummary[] },
): Html {
  const c = data.counts;
  const stat = (n: number, label: string, href: string) => html`<a class="card stat" href="${href}"><div class="n">${n}</div><div class="l">${label}</div></a>`;
  return layout(staff, 'Översikt', html`
<h1>Översikt</h1>
<div class="grid cols-4">
  ${stat(c.paid, 'Att plocka', '/admin/orders?status=paid')}
  ${stat(c.picking, 'Plockas just nu', '/admin/orders?status=picking')}
  ${stat(c.packed, 'Packade – att skicka', '/admin/orders?status=packed')}
  ${stat(c.shipped, 'På väg till kund', '/admin/orders?status=shipped')}
  ${stat(c.pending, 'Väntar på betalning', '/admin/orders?status=pending')}
  ${stat(data.refundDue.length, 'Återbetalning väntar', '/admin/orders?refund=due')}
  ${stat(data.lowStock.length, 'Produkter med lågt lager', '/admin/products?lowStock=1')}
  ${stat(c.delivered, 'Levererade totalt', '/admin/orders?status=delivered')}
  ${stat(data.subs.active, 'Aktiva prenumerationer', '/admin/subscriptions?status=active')}
  ${stat(data.subs.dueWithin7Days, 'Förnyas inom 7 dagar', '/admin/subscriptions?status=active')}
  ${stat(data.subs.paused, 'Pausade prenumerationer', '/admin/subscriptions?status=paused')}
</div>
${data.labelProvider.id !== 'manual' && !data.labelProvider.configured ? html`<div class="flash err">Etikettleverantören ${data.labelProvider.name} är vald men saknar nycklar – se .env.example.</div>` : ''}
<div class="grid cols-2">
<div class="card"><h2 style="margin-top:0">Den här månadens box</h2>
${data.currentEdition
  ? html`<p><a href="/admin/editions/${data.currentEdition.id}"><strong>${data.currentEdition.name}</strong></a> · ${data.currentEdition.totalCans} dosor · ${data.currentEdition.status === 'locked' ? html`<span class="badge delivered">Låst</span>` : html`<span class="badge pending">Utkast</span>`}</p>
     ${data.currentEdition.status === 'draft' ? html`<p class="small" style="color:var(--warn)">Boxen måste låsas innan plockningen kan starta.</p>` : ''}
     <p class="small muted">${data.currentEdition.orderCount} ordrar · ${data.currentEdition.ratingCount} betyg</p>`
  : html`<p style="color:var(--warn)">Ingen box är skapad för den här månaden. <a href="/admin/editions">Skapa den</a> innan prenumerationsordrarna ska plockas.</p>`}
</div>
<div class="card"><h2 style="margin-top:0">Utskicksvågor</h2>
<table><tr><th>Grupp</th><th class="num">Aktiva</th><th class="num">Pausade</th><th>Nästa utskick</th></tr>
${data.waves.map((w) => html`<tr><td>${w.label}</td><td class="num">${w.active}</td><td class="num">${w.paused}</td><td class="small">${fmtDate(w.nextRenewalAt)}</td></tr>`)}
</table>
<p class="small muted"><a href="/admin/subscriptions">Hantera prenumerationer och vågor</a></p>
</div>
</div>
<div class="grid cols-2">
<div class="card"><h2 style="margin-top:0">Plockkö</h2>${orderTable(data.queue, { compact: true })}</div>
<div class="card"><h2 style="margin-top:0">Lågt lager (≤ ${config.lowStockThreshold} st)</h2>
${data.lowStock.length === 0 ? html`<p class="muted">Inga produkter under gränsen.</p>` : html`<table><tr><th>SKU</th><th>Produkt</th><th class="num">Tillgängligt</th></tr>
${data.lowStock.map((p) => html`<tr><td class="mono"><a href="/admin/products/${p.id}">${p.sku}</a></td><td>${p.brand} ${p.name}</td><td class="num">${availableStock(p)}</td></tr>`)}</table>`}
</div>
</div>
${data.refundDue.length ? html`<div class="card"><h2 style="margin-top:0">Återbetalningar att hantera</h2>${orderTable(data.refundDue, { compact: true })}</div>` : ''}
`, { path: '/admin' });
}

/* ---------- Ordrar ---------- */

export function orderTable(orders: OrderListItem[], opts: { compact?: boolean } = {}): Html {
  if (orders.length === 0) return html`<p class="muted">Inga ordrar.</p>`;
  return html`<table>
<tr><th>Order</th><th>Datum</th><th>Kund</th><th>Status</th>${opts.compact ? '' : html`<th>Betalning</th><th>Rader</th>`}<th class="num">Summa</th></tr>
${orders.map((o) => html`<tr>
<td><a href="/admin/orders/${o.id}" class="mono">${o.orderNumber}</a>${o.externalRef ? html`<div class="small muted">${o.externalRef}</div>` : ''}</td>
<td class="small">${fmtDate(o.placedAt)}</td>
<td>${o.customerName}<div class="small muted">${o.shipCity}</div></td>
<td>${statusBadge(o.status)}</td>
${opts.compact ? '' : html`<td><span class="badge ${o.paymentStatus}">${PAYMENT_STATUS_LABELS[o.paymentStatus]}</span><div class="small muted">${o.paymentMethod ?? ''}</div></td><td>${o.lineCount}</td>`}
<td class="num">${formatSek(o.totalOre)}</td>
</tr>`)}
</table>`;
}

export function ordersPage(staff: StaffUser, data: { orders: OrderListItem[]; status?: string; q?: string; refund?: string; msg?: string; err?: string }): Html {
  const filter = (value: string | undefined, label: string) =>
    html`<a href="/admin/orders${value ? `?status=${value}` : ''}" class="${(data.status ?? '') === (value ?? '') && !data.refund ? 'active' : ''}">${label}</a>`;
  return layout(staff, 'Ordrar', html`
<h1>Ordrar</h1>
<div class="filters">
${filter(undefined, 'Alla')}
${ORDER_STATUSES.map((s) => filter(s, STATUS_LABELS[s]))}
<a href="/admin/orders?refund=due" class="${data.refund ? 'active' : ''}">Återbetalning väntar</a>
<form method="get" action="/admin/orders"><input type="search" name="q" placeholder="Sök ordernr, namn, e-post…" value="${data.q ?? ''}"><button type="submit" class="secondary">Sök</button></form>
</div>
<div class="row" style="margin-bottom:12px"><a class="btn" href="/admin/orders/new">+ Ny manuell order</a></div>
<div class="card">${orderTable(data.orders)}</div>
`, { path: '/admin/orders', msg: data.msg, err: data.err });
}

export function orderPage(staff: StaffUser, order: OrderDetail, products: Product[], opts: { msg?: string; err?: string; labelProvider?: { id: string; name: string; configured: boolean } } = {}): Html {
  const canBookLabel = Boolean(opts.labelProvider?.configured);
  const next = allowedTransitions(order.status);
  const can = (s: OrderStatus) => next.includes(s);
  const action = (name: string, label: string, cls = '') =>
    html`<form class="inline" method="post" action="/admin/orders/${order.id}/actions/${name}"><button type="submit" class="${cls}">${label}</button></form>`;

  return layout(staff, order.orderNumber, html`
<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
  <h1 style="margin:0">Order ${order.orderNumber} ${statusBadge(order.status)} <span class="badge ${order.paymentStatus}">${PAYMENT_STATUS_LABELS[order.paymentStatus]}</span></h1>
  <div><a class="btn secondary" href="/admin/orders/${order.id}/packslip" target="_blank">Skriv ut packsedel</a></div>
</div>

<div class="card no-print">
<h2 style="margin-top:0">Åtgärder</h2>
<div class="actions">
  ${order.status === 'pending' ? html`<form class="inline" method="post" action="/admin/orders/${order.id}/actions/pay"><input name="paymentRef" placeholder="Betalningsreferens" style="width:200px;display:inline-block;margin-right:6px"><button type="submit">Markera som betald</button></form>` : ''}
  ${can('picking') && order.status === 'paid' ? action('pick', 'Starta plockning (föreslå boxinnehåll)') : ''}
  ${can('picking') && order.status === 'packed' ? action('reopen', 'Öppna igen för plockning', 'secondary') : ''}
  ${order.status === 'picking' ? action('pick', 'Föreslå boxinnehåll på nytt', 'secondary') : ''}
  ${order.status === 'picking' ? action('cancel-picking', 'Avbryt plockning', 'secondary') : ''}
  ${can('packed') ? action('pack', 'Bekräfta packning (dra lager)') : ''}
  ${can('delivered') ? action('deliver', 'Markera som levererad') : ''}
  ${can('returned') ? html`<form class="inline" method="post" action="/admin/orders/${order.id}/actions/return"><label style="display:inline"><input type="checkbox" name="restock" value="1" style="width:auto"> Lägg tillbaka i lager</label> <input name="reason" placeholder="Anledning" style="width:180px;display:inline-block"> <button type="submit" class="warn">Registrera retur</button></form>` : ''}
  ${order.paymentStatus === 'refund_due' ? action('refund', 'Markera som återbetald', 'warn') : ''}
  ${can('cancelled') ? html`<form class="inline" method="post" action="/admin/orders/${order.id}/actions/cancel" onsubmit="return confirm('Avbryt ordern ${order.orderNumber}?')"><input name="reason" placeholder="Anledning" style="width:180px;display:inline-block"> <button type="submit" class="danger">Avbryt order</button></form>` : ''}
</div>
${can('shipped') ? html`
<h3>Skicka</h3>
<form method="post" action="/admin/orders/${order.id}/actions/ship" class="row">
  <div class="field"><label>Transportör</label><select name="carrier">${CARRIERS.map((k) => html`<option value="${k}">${CARRIER_LABELS[k]}</option>`)}</select></div>
  <div class="field"><label>Tjänst</label><input name="service" placeholder="t.ex. MyPack Collect"></div>
  <div class="field"><label>Kollinummer</label><input name="trackingNumber"></div>
  <div class="field"><label>Ombud / box</label><input name="pickupPoint"></div>
  <div class="field" style="max-width:110px"><label>Vikt (g)</label><input name="weightGrams" type="number" min="1" placeholder="auto"></div>
  <div class="field" style="flex:0"><button type="submit">Registrera som skickad</button></div>
</form>
${canBookLabel ? html`<p class="small muted">Lämnas kollinumret tomt bokas försändelsen automatiskt hos ${opts.labelProvider?.name} och etiketten kan skrivas ut direkt.</p>` : html`<p class="small muted">Ingen etikettleverantör är kopplad (LABEL_PROVIDER=manual) – skriv in kollinumret från transportörens system.</p>`}` : ''}
</div>

<div class="grid cols-2">
<div class="card">
<h2 style="margin-top:0">Innehåll</h2>
<table><tr><th>Rad</th><th class="num">Antal</th><th class="num">À-pris</th><th class="num">Summa</th></tr>
${order.lines.map((l) => html`<tr><td>${l.description}${l.sku ? html` <span class="mono muted">${l.sku}</span>` : ''}</td><td class="num">${l.quantity}</td><td class="num">${formatSek(l.unitPriceOre)}</td><td class="num">${formatSek(l.unitPriceOre * l.quantity)}</td></tr>`)}
<tr><td colspan="3" class="right muted">Frakt</td><td class="num">${formatSek(order.shippingOre)}</td></tr>
<tr><td colspan="3" class="right muted">Varav moms</td><td class="num">${formatSek(order.vatOre)}</td></tr>
<tr><td colspan="3" class="right"><strong>Totalt</strong></td><td class="num"><strong>${formatSek(order.totalOre)}</strong></td></tr>
</table>
${order.lines.filter((l) => l.kind === 'mystery_box').map((l) => html`
<h3>${l.description} – innehåll (${l.picks.reduce((s, p) => s + p.quantity, 0)} / ${(l.boxSize ?? 0) * l.quantity})</h3>
${order.status === 'picking' ? html`
<form method="post" action="/admin/orders/${order.id}/lines/${l.id}/picks">
<table><tr><th>Produkt</th><th>Styrka</th><th class="num" style="width:90px">Antal</th></tr>
${l.picks.map((p) => html`<tr><td><span class="mono">${p.sku}</span> ${p.brand} ${p.productName}</td><td class="small">${STRENGTH_LABELS[p.strength]}</td><td class="num"><input type="number" name="pick_${p.productId}" value="${p.quantity}" min="0" style="width:80px"></td></tr>`)}
<tr><td colspan="2"><select name="addProductId"><option value="">+ Lägg till produkt…</option>${products.map((p) => html`<option value="${p.id}">${p.sku} – ${p.brand} ${p.name} (${availableStock(p)} st)</option>`)}</select></td><td class="num"><input type="number" name="addQuantity" value="1" min="1" style="width:80px"></td></tr>
</table>
<div class="actions"><button type="submit" class="secondary">Spara innehåll</button></div>
</form>` : l.picks.length === 0 ? html`<p class="muted small">Innehållet föreslås när plockningen startar.</p>` : html`<table>${l.picks.map((p) => html`<tr><td><span class="mono">${p.sku}</span> ${p.brand} ${p.productName}</td><td class="small">${STRENGTH_LABELS[p.strength]} · ${p.flavor}</td><td class="num">${p.quantity}</td></tr>`)}</table>`}
`)}
</div>

<div>
<div class="card">
<h2 style="margin-top:0">Kund & leverans</h2>
<dl>
<dt>Kund</dt><dd><a href="/admin/customers/${order.customer.id}">${fullName(order.customer)}</a><br><span class="small muted">${order.customer.email}${order.customer.phone ? ` · ${order.customer.phone}` : ''}</span></dd>
<dt>Adress</dt><dd>${order.shipName}<br>${order.shipStreet}<br>${order.shipPostalCode} ${order.shipCity}${order.shipCountry !== 'SE' ? html`<br>${order.shipCountry}` : ''}</dd>
<dt>Preferenser</dt><dd>${order.customer.prefStrength ? STRENGTH_LABELS[order.customer.prefStrength] : '–'}${order.customer.prefFlavors.length ? html` · gillar: ${order.customer.prefFlavors.join(', ')}` : ''}${order.customer.excludedFlavors.length ? html` · <span style="color:var(--danger)">undviker: ${order.customer.excludedFlavors.join(', ')}</span>` : ''}</dd>
<dt>Ålder</dt><dd>${order.ageVerified ? 'Verifierad vid köp' : 'Enligt födelsedatum'} (${order.customer.birthDate})</dd>
<dt>Betalning</dt><dd>${order.paymentMethod ?? '–'}${order.paymentRef ? html` <span class="mono">${order.paymentRef}</span>` : ''}</dd>
<dt>Kanal</dt><dd>${order.channel}${order.externalRef ? html` · <span class="mono">${order.externalRef}</span>` : ''}${order.subscriptionId ? html` · <a href="/admin/subscriptions/${order.subscriptionId}">Prenumeration #${order.subscriptionId}</a>${order.period ? ` (${order.period})` : ''}` : ''}</dd>
<dt>Lagd</dt><dd>${fmtDate(order.placedAt)}</dd>
${order.customerNote ? html`<dt>Kundens meddelande</dt><dd>${order.customerNote}</dd>` : ''}
</dl>
</div>

<div class="card">
<h2 style="margin-top:0">Försändelser</h2>
${order.shipments.length === 0 ? html`<p class="muted">Inga försändelser ännu.</p>` : order.shipments.map((s) => html`<p>${CARRIER_LABELS[s.carrier]}${s.service ? ` · ${s.service}` : ''} ${shipmentBadge(s.status)}<br>
${s.trackingNumber ? html`<span class="mono">${s.trackingUrl ? html`<a href="${s.trackingUrl}" target="_blank" rel="noopener">${s.trackingNumber}</a>` : s.trackingNumber}</span>` : html`<span class="muted small">Inget kollinummer</span>`}
${s.pickupPoint ? html`<br><span class="small">Ombud: ${s.pickupPoint}</span>` : ''}${s.weightGrams ? html` <span class="small muted">· ${s.weightGrams} g</span>` : ''}
${s.labelCreatedAt ? html`<br><a class="btn secondary" style="padding:3px 10px;font-size:13px" href="/api/v1/shipments/${s.id}/label" target="_blank">Skriv ut etikett (${s.labelFormat ?? ''})</a> <span class="small muted">via ${s.labelProvider}</span>` : canBookLabel ? html`<br><form class="inline" method="post" action="/admin/shipments/${s.id}/label"><button type="submit" style="padding:3px 10px;font-size:13px">Boka & skapa etikett (${opts.labelProvider?.name})</button></form>` : ''}
<br><a class="small" href="/admin/shipments#s${s.id}">Hantera händelser</a></p>`)}
</div>

<div class="card">
<h2 style="margin-top:0">Intern anteckning</h2>
<form method="post" action="/admin/orders/${order.id}/note"><textarea name="internalNote">${order.internalNote ?? ''}</textarea><div class="actions"><button type="submit" class="secondary">Spara</button></div></form>
</div>

<div class="card">
<h2 style="margin-top:0">Historik</h2>
<ul class="timeline">${order.events.map((e) => html`<li><span class="t">${fmtDate(e.createdAt)}</span>${e.message} <span class="muted">· ${e.actor}</span></li>`)}</ul>
</div>
</div>
</div>
`, { path: '/admin/orders', ...opts });
}

export function packSlipPage(order: OrderDetail): Html {
  return html`<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Packsedel ${order.orderNumber}</title><style>${raw(CSS)} body{background:#fff} main{max-width:700px}</style></head><body><main>
<div class="no-print" style="margin-bottom:12px"><button onclick="window.print()">Skriv ut</button> <a class="btn secondary" href="/admin/orders/${order.id}">Tillbaka</a></div>
<h1>Packsedel ${order.orderNumber}</h1>
<p><strong>Mysterysnus.se</strong> · Lagd ${fmtDate(order.placedAt)}${order.externalRef ? ` · Ref ${order.externalRef}` : ''}</p>
<div class="card"><strong>Leverans till</strong><br>${order.shipName}<br>${order.shipStreet}<br>${order.shipPostalCode} ${order.shipCity}${order.shipPhone ? html`<br>${order.shipPhone}` : ''}</div>
<table><tr><th>Plocka</th><th class="num">Antal</th><th style="width:60px">✓</th></tr>
${order.lines.map((l) => l.kind === 'product'
  ? html`<tr><td><span class="mono">${l.sku}</span> ${l.description}</td><td class="num">${l.quantity}</td><td>☐</td></tr>`
  : html`<tr><td colspan="3"><strong>${l.description} × ${l.quantity}</strong></td></tr>${l.picks.map((p) => html`<tr><td>&nbsp;&nbsp;&nbsp;<span class="mono">${p.sku}</span> ${p.brand} ${p.productName} <span class="muted small">(${STRENGTH_LABELS[p.strength]}, ${p.flavor})</span></td><td class="num">${p.quantity}</td><td>☐</td></tr>`)}`)}
</table>
${order.customerNote ? html`<p><strong>Kundens meddelande:</strong> ${order.customerNote}</p>` : ''}
<p class="small muted">Innehåller nikotin som är ett mycket beroendeframkallande ämne. Säljs endast till personer över 18 år.</p>
</main></body></html>`;
}

export function newOrderPage(staff: StaffUser, customers: Customer[], products: Product[], opts: { err?: string } = {}): Html {
  return layout(staff, 'Ny order', html`
<h1>Ny manuell order</h1>
<div class="card">
<form method="post" action="/admin/orders/new">
<div class="row">
  <div class="field"><label>Kund</label><select name="customerId" required><option value="">Välj kund…</option>${customers.map((c) => html`<option value="${c.id}">${fullName(c)} – ${c.email}</option>`)}</select></div>
  <div class="field"><label>Betalning</label><select name="paymentStatus"><option value="unpaid">Obetald (faktura/väntar)</option><option value="paid">Redan betald</option></select></div>
  <div class="field"><label>Betalsätt</label><input name="paymentMethod" placeholder="swish / kort / faktura"></div>
</div>
<h3>Månadens box</h3>
<div class="row">
  <div class="field"><label>Box</label><select name="boxSize"><option value="">Ingen box</option>${Object.entries(config.mysteryBoxPricesOre).map(([size, price]) => html`<option value="${size}">Månadens box (${size} dosor) – ${formatSek(price)}</option>`)}</select></div>
  <div class="field"><label>Antal boxar</label><input type="number" name="boxQuantity" value="1" min="1"></div>
</div>
<p class="small muted">Innehållet hämtas från den här månadens box och är detsamma som alla andra kunder får.</p>
<h3>Enskilda produkter</h3>
<p class="small muted">En rad per produkt: <span class="mono">SKU antal</span>, t.ex. <span class="mono">ZYN-COOL-MINT-S 3</span>. Tillgängliga: ${products.map((p) => p.sku).join(', ')}</p>
<div class="field"><textarea name="productLines" placeholder="VELO-ICE-COOL-S 2"></textarea></div>
<div class="field"><label>Kundens meddelande</label><input name="customerNote"></div>
<p class="small muted">Leveransadress hämtas från kundkortet. Frakt: ${formatSek(config.shipping.standardOre)}, fri frakt från ${formatSek(config.shipping.freeThresholdOre)}.</p>
<div class="actions"><button type="submit">Skapa order</button> <a class="btn secondary" href="/admin/orders">Avbryt</a></div>
</form></div>
`, { path: '/admin/orders', err: opts.err });
}

/* ---------- Kunder ---------- */

export function customersPage(staff: StaffUser, data: { customers: CustomerListItem[]; q?: string; msg?: string }): Html {
  return layout(staff, 'Kunder', html`
<h1>Kunder</h1>
<div class="filters"><a class="btn" href="/admin/customers/new">+ Ny kund</a>
<form method="get" action="/admin/customers"><input type="search" name="q" placeholder="Sök namn, e-post, ort…" value="${data.q ?? ''}"><button type="submit" class="secondary">Sök</button></form></div>
<div class="card">
${data.customers.length === 0 ? html`<p class="muted">Inga kunder.</p>` : html`<table><tr><th>Namn</th><th>E-post</th><th>Ort</th><th>Preferens</th><th class="num">Ordrar</th><th class="num">Köpt för</th><th>Status</th></tr>
${data.customers.map((c) => html`<tr><td><a href="/admin/customers/${c.id}">${fullName(c)}</a></td><td>${c.email}</td><td>${c.city ?? '–'}</td><td class="small">${c.prefStrength ? STRENGTH_LABELS[c.prefStrength] : '–'}${c.prefFlavors.length ? ` · ${c.prefFlavors.join(', ')}` : ''}</td><td class="num">${c.orderCount}</td><td class="num">${formatSek(c.lifetimeValueOre)}</td><td>${c.status === 'blocked' ? html`<span class="badge cancelled">Spärrad</span>` : html`<span class="badge delivered">Aktiv</span>`}</td></tr>`)}</table>`}
</div>`, { path: '/admin/customers', msg: data.msg });
}

function customerForm(c: Partial<Customer>, action: string, submitLabel: string): Html {
  const v = (s: string | null | undefined) => s ?? '';
  return html`<form method="post" action="${action}">
<div class="row"><div class="field"><label>Förnamn</label><input name="firstName" value="${v(c.firstName)}" required></div><div class="field"><label>Efternamn</label><input name="lastName" value="${v(c.lastName)}" required></div></div>
<div class="row"><div class="field"><label>E-post</label><input type="email" name="email" value="${v(c.email)}" required></div><div class="field"><label>Telefon</label><input name="phone" value="${v(c.phone)}"></div><div class="field"><label>Födelsedatum</label><input type="date" name="birthDate" value="${v(c.birthDate)}" required></div></div>
<div class="row"><div class="field" style="flex:2"><label>Gatuadress</label><input name="street" value="${v(c.street)}"></div><div class="field"><label>Postnummer</label><input name="postalCode" value="${v(c.postalCode)}"></div><div class="field"><label>Ort</label><input name="city" value="${v(c.city)}"></div><div class="field" style="max-width:80px"><label>Land</label><input name="country" value="${c.country ?? 'SE'}" maxlength="2"></div></div>
<div class="row">
<div class="field"><label>Föredragen styrka</label><select name="prefStrength"><option value="">–</option>${STRENGTHS.map((s) => html`<option value="${s}" ${c.prefStrength === s ? 'selected' : ''}>${STRENGTH_LABELS[s]}</option>`)}</select></div>
<div class="field"><label>Gillar smaker (kommaseparerat)</label><input name="prefFlavors" value="${(c.prefFlavors ?? []).join(', ')}"></div>
<div class="field"><label>Undviker smaker (kommaseparerat)</label><input name="excludedFlavors" value="${(c.excludedFlavors ?? []).join(', ')}"></div>
</div>
<div class="row"><div class="field"><label><input type="checkbox" name="marketingConsent" value="1" style="width:auto" ${c.marketingConsent ? 'checked' : ''}> Samtycker till marknadsföring</label></div>
${c.id ? html`<div class="field"><label>Status</label><select name="status"><option value="active" ${c.status === 'active' ? 'selected' : ''}>Aktiv</option><option value="blocked" ${c.status === 'blocked' ? 'selected' : ''}>Spärrad</option></select></div>` : ''}</div>
<div class="field"><label>Anteckningar</label><textarea name="notes">${v(c.notes)}</textarea></div>
<div class="actions"><button type="submit">${submitLabel}</button></div>
</form>`;
}

export function newCustomerPage(staff: StaffUser, opts: { err?: string; values?: Partial<Customer> } = {}): Html {
  return layout(staff, 'Ny kund', html`<h1>Ny kund</h1><div class="card">${customerForm(opts.values ?? {}, '/admin/customers/new', 'Skapa kund')}</div>`, { path: '/admin/customers', err: opts.err });
}

export function customerPage(
  staff: StaffUser,
  customer: Customer,
  orders: OrderListItem[],
  subscriptions: Subscription[],
  ratings: CustomerRatingHistoryRow[],
  opts: { msg?: string; err?: string } = {},
): Html {
  return layout(staff, fullName(customer), html`
<h1>${fullName(customer)} ${customer.status === 'blocked' ? html`<span class="badge cancelled">Spärrad</span>` : ''}</h1>
<div class="grid cols-2">
<div class="card"><h2 style="margin-top:0">Uppgifter</h2>${customerForm(customer, `/admin/customers/${customer.id}`, 'Spara')}</div>
<div>
<div class="card"><h2 style="margin-top:0">Prenumerationer</h2>
${subscriptions.length === 0 ? html`<p class="muted">Ingen prenumeration.</p>` : html`<table><tr><th>#</th><th>Box</th><th>Status</th><th>Nästa box</th><th class="num">Pris/mån</th></tr>
${subscriptions.map((s) => html`<tr><td><a href="/admin/subscriptions/${s.id}">#${s.id}</a></td><td>${s.boxSize} dosor × ${s.quantity}${s.strength ? html` <span class="small muted">${STRENGTH_LABELS[s.strength]}</span>` : ''}</td><td>${subscriptionBadge(s.status)}</td><td class="small">${fmtDate(s.nextRenewalAt)}</td><td class="num">${formatSek(s.priceOre)}</td></tr>`)}</table>`}
<details style="margin-top:10px"><summary class="small">+ Ny prenumeration</summary>
<form method="post" action="/admin/customers/${customer.id}/subscriptions" class="row" style="margin-top:8px">
<div class="field"><label>Dosor/box</label><input type="number" name="boxSize" value="${config.defaultBoxSize}" min="1"></div>
<div class="field"><label>Antal boxar</label><input type="number" name="quantity" value="1" min="1"></div>
<div class="field"><label>Styrka</label><select name="strength"><option value="">Kundens preferens</option>${STRENGTHS.map((st) => html`<option value="${st}">${STRENGTH_LABELS[st]}</option>`)}</select></div>
<div class="field"><label>Pris/mån (kr)</label><input type="number" step="0.01" name="priceKr" placeholder="${((config.mysteryBoxPricesOre[config.defaultBoxSize] ?? 0) / 100).toFixed(0)}"></div>
<div class="field"><label>Första box</label><input type="date" name="startDate" value="${new Date().toISOString().slice(0, 10)}"></div>
<div class="field"><label>Betalsätt</label><input name="paymentMethod" placeholder="klarna / kort"></div>
<div class="field" style="flex:0"><button type="submit">Skapa</button></div>
</form></details>
</div>
<div class="card"><h2 style="margin-top:0">Ordrar</h2>${orderTable(orders, { compact: true })}<p class="small muted">Kund sedan ${fmtDate(customer.createdAt)}</p></div>
</div>
</div>
<div class="card">
<h2 style="margin-top:0">Betyg och omdömen (${ratings.length})</h2>
${ratings.length === 0 ? html`<p class="muted">Kunden har inte betygsatt något ännu.</p>` : html`<table>
<tr><th>Box</th><th>Produkt</th><th>Betyg</th><th>Omdöme</th><th>Köper igen</th><th>Kommentar</th></tr>
${ratings.map((r) => html`<tr>
<td class="small"><a href="/admin/editions/${r.editionId}">${r.period}</a></td>
<td><span class="mono">${r.sku}</span> <span class="small">${r.brand} ${r.productName}</span></td>
<td>${r.rating == null ? '–' : `${r.rating}/5`}</td>
<td class="small">${r.sentiment ? SENTIMENT_LABELS[r.sentiment] : '–'}</td>
<td class="small">${r.wouldBuyAgain == null ? '–' : r.wouldBuyAgain ? 'Ja' : 'Nej'}</td>
<td class="small">${r.comment ?? ''}</td>
</tr>`)}
</table>`}
<p class="small muted">Kundens publika token för betygs- och köplänkar: <span class="mono">${customer.publicToken}</span></p>
</div>`, { path: '/admin/customers', ...opts });
}

/* ---------- Produkter ---------- */

export function productsPage(staff: StaffUser, data: { products: Product[]; supplierNames: Map<number, string>; q?: string; lowStock?: boolean; msg?: string; err?: string }): Html {
  return layout(staff, 'Produkter & lager', html`
<h1>Produkter & lager</h1>
<div class="filters"><a href="/admin/products" class="${!data.lowStock ? 'active' : ''}">Alla</a><a href="/admin/products?lowStock=1" class="${data.lowStock ? 'active' : ''}">Lågt lager</a><a class="btn" href="/admin/products/new">+ Ny produkt</a><a href="/admin/suppliers">Leverantörer</a>
<form method="get" action="/admin/products"><input type="search" name="q" placeholder="Sök SKU, namn, märke, smak…" value="${data.q ?? ''}"><button type="submit" class="secondary">Sök</button></form></div>
<div class="card"><table>
<tr><th>SKU</th><th>Produkt</th><th>Smak</th><th>Styrka</th><th>Leverantör</th><th class="num">Pris</th><th class="num">Saldo</th><th class="num">Reserverat</th><th class="num">Tillgängligt</th><th>Snabbjustering</th></tr>
${data.products.map((p) => html`<tr>
<td class="mono"><a href="/admin/products/${p.id}">${p.sku}</a></td>
<td>${p.brand} ${p.name}${p.active ? '' : html` <span class="badge cancelled">Inaktiv</span>`}</td>
<td>${p.flavor}</td><td class="small">${STRENGTH_LABELS[p.strength]}${p.nicotineMg != null ? html` <span class="muted">${p.nicotineMg} mg</span>` : ''}</td>
<td class="small">${data.supplierNames.get(p.supplierId ?? -1) ?? html`<span class="muted">–</span>`}</td>
<td class="num">${formatSek(p.priceOre)}</td><td class="num">${p.stockOnHand}</td><td class="num">${p.stockReserved}</td>
<td class="num">${availableStock(p)} ${isLowStock(p) ? html`<span class="badge low">Lågt</span>` : ''}</td>
<td><form method="post" action="/admin/products/${p.id}/stock" class="row" style="gap:4px"><input type="number" name="delta" placeholder="±" style="width:70px" required><select name="reason" style="width:120px"><option value="purchase">Inleverans</option><option value="adjustment">Inventering</option><option value="return">Retur</option><option value="correction">Rättelse</option></select><button type="submit" class="secondary">OK</button></form></td>
</tr>`)}
</table></div>`, { path: '/admin/products', msg: data.msg, err: data.err });
}

function productForm(p: Partial<Product>, action: string, submitLabel: string, suppliers: Supplier[] = []): Html {
  const v = (s: string | number | null | undefined) => (s == null ? '' : String(s));
  return html`<form method="post" action="${action}">
<div class="row"><div class="field"><label>SKU</label><input name="sku" value="${v(p.sku)}" required></div><div class="field"><label>Märke</label><input name="brand" value="${v(p.brand)}" required></div><div class="field" style="flex:2"><label>Namn</label><input name="name" value="${v(p.name)}" required></div></div>
<div class="row"><div class="field"><label>Smak</label><input name="flavor" value="${v(p.flavor)}" required placeholder="mint, citrus, bär…"></div>
<div class="field"><label>Styrka</label><select name="strength">${STRENGTHS.map((s) => html`<option value="${s}" ${p.strength === s ? 'selected' : ''}>${STRENGTH_LABELS[s]}</option>`)}</select></div>
<div class="field"><label>Nikotin (mg/portion)</label><input type="number" step="0.1" name="nicotineMg" value="${v(p.nicotineMg)}"></div>
<div class="field"><label>Format</label><select name="format">${FORMATS.map((f) => html`<option value="${f}" ${(p.format ?? 'slim') === f ? 'selected' : ''}>${f}</option>`)}</select></div></div>
<div class="row"><div class="field"><label>Pris (kr inkl. moms)</label><input type="number" step="0.01" name="priceKr" value="${p.priceOre != null ? (p.priceOre / 100).toFixed(2) : ''}" required></div>
<div class="field"><label>Moms %</label><input type="number" name="vatRate" value="${p.vatRate ?? config.vatRate}"></div>
<div class="field"><label>Vikt (g/dosa)</label><input type="number" name="weightGrams" value="${p.weightGrams ?? 20}"></div>
<div class="field"><label>Leverantör</label><select name="supplierId"><option value="">–</option>${suppliers.map((s) => html`<option value="${s.id}" ${p.supplierId === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></div>
<div class="field"><label><input type="checkbox" name="active" value="1" style="width:auto" ${p.active !== false ? 'checked' : ''}> Aktiv (kan säljas och plockas)</label></div></div>
<div class="actions"><button type="submit">${submitLabel}</button></div></form>`;
}

export function newProductPage(staff: StaffUser, suppliers: Supplier[], opts: { err?: string } = {}): Html {
  return layout(staff, 'Ny produkt', html`<h1>Ny produkt</h1><div class="card">${productForm({}, '/admin/products/new', 'Skapa produkt', suppliers)}</div>`, { path: '/admin/products', err: opts.err });
}

export function productPage(
  staff: StaffUser,
  product: Product,
  movements: StockMovement[],
  suppliers: Supplier[],
  history: ProductHistoryRow[],
  opts: { msg?: string; err?: string } = {},
): Html {
  const reasons: Record<string, string> = { purchase: 'Inleverans', adjustment: 'Inventering', pick: 'Plock', return: 'Retur', correction: 'Rättelse' };
  return layout(staff, product.sku, html`
<h1>${product.brand} ${product.name} <span class="mono muted">${product.sku}</span></h1>
<div class="grid cols-2">
<div class="card"><h2 style="margin-top:0">Produkt</h2>${productForm(product, `/admin/products/${product.id}`, 'Spara', suppliers)}<p class="small muted"><a href="/admin/suppliers">Hantera leverantörer</a></p></div>
<div>
<div class="card"><h2 style="margin-top:0">Lager</h2>
<dl><dt>Saldo</dt><dd>${product.stockOnHand}</dd><dt>Reserverat</dt><dd>${product.stockReserved}</dd><dt>Tillgängligt</dt><dd><strong>${availableStock(product)}</strong> ${isLowStock(product) ? html`<span class="badge low">Lågt</span>` : ''}</dd></dl>
<form method="post" action="/admin/products/${product.id}/stock" class="row" style="margin-top:10px">
<div class="field"><label>Ändring (±)</label><input type="number" name="delta" required></div>
<div class="field"><label>Orsak</label><select name="reason"><option value="purchase">Inleverans</option><option value="adjustment">Inventering</option><option value="return">Retur</option><option value="correction">Rättelse</option></select></div>
<div class="field" style="flex:2"><label>Notering</label><input name="note"></div>
<div class="field" style="flex:0"><button type="submit">Registrera</button></div></form></div>
<div class="card"><h2 style="margin-top:0">Mottagande i boxarna</h2>
${history.length === 0 ? html`<p class="muted">Produkten har inte ingått i någon box ännu.</p>` : html`<table><tr><th>Box</th><th class="num">Svar</th><th>Snittbetyg</th><th class="num">Gillar</th><th class="num">Ogillar</th><th class="num">Klick</th></tr>
${history.map((h) => html`<tr><td><a href="/admin/editions/${h.editionId}">${periodLabel(h.period)}</a></td><td class="num">${h.responses}</td><td>${h.averageRating == null ? '–' : `${h.averageRating}/5`}</td><td class="num">${h.likes}</td><td class="num">${h.dislikes}</td><td class="num">${h.clicks}</td></tr>`)}
</table>`}</div>
<div class="card"><h2 style="margin-top:0">Lagerhistorik</h2>
${movements.length === 0 ? html`<p class="muted">Inga rörelser.</p>` : html`<table><tr><th>När</th><th>Orsak</th><th class="num">Ändring</th><th>Referens</th></tr>
${movements.map((m) => html`<tr><td class="small">${fmtDate(m.createdAt)}</td><td>${reasons[m.reason] ?? m.reason}</td><td class="num">${m.delta > 0 ? `+${m.delta}` : m.delta}</td><td class="small mono">${m.reference ?? ''} <span class="muted">${m.note ?? ''}</span></td></tr>`)}</table>`}
</div></div></div>`, { path: '/admin/products', ...opts });
}

/* ---------- Försändelser ---------- */

export function shipmentsPage(staff: StaffUser, data: { shipments: ShipmentListItem[]; status?: string; q?: string; msg?: string; err?: string }): Html {
  return layout(staff, 'Försändelser', html`
<h1>Försändelser</h1>
<div class="filters"><a href="/admin/shipments" class="${!data.status ? 'active' : ''}">Alla</a>${SHIPMENT_STATUSES.map((s) => html`<a href="/admin/shipments?status=${s}" class="${data.status === s ? 'active' : ''}">${SHIPMENT_STATUS_LABELS[s]}</a>`)}
<form method="get" action="/admin/shipments"><input type="search" name="q" placeholder="Sök kollinr, ordernr, namn…" value="${data.q ?? ''}"><button type="submit" class="secondary">Sök</button></form></div>
<div class="card">
${data.shipments.length === 0 ? html`<p class="muted">Inga försändelser.</p>` : html`<table>
<tr><th>Order</th><th>Mottagare</th><th>Transportör</th><th>Kollinummer</th><th>Status</th><th>Skickad</th><th>Uppdatera</th></tr>
${data.shipments.map((s) => html`<tr id="s${s.id}">
<td><a href="/admin/orders/${s.orderId}" class="mono">${s.orderNumber}</a></td><td>${s.shipName}<div class="small muted">${s.shipCity}</div></td>
<td>${CARRIER_LABELS[s.carrier]}${s.service ? html`<div class="small muted">${s.service}</div>` : ''}</td>
<td class="mono">${s.trackingNumber ? (s.trackingUrl ? html`<a href="${s.trackingUrl}" target="_blank" rel="noopener">${s.trackingNumber}</a>` : s.trackingNumber) : html`<form method="post" action="/admin/shipments/${s.id}" class="row" style="gap:4px"><input name="trackingNumber" placeholder="Kollinummer" style="width:170px"><button type="submit" class="secondary">Spara</button></form>`}</td>
<td>${shipmentBadge(s.status)}</td><td class="small">${fmtDate(s.shippedAt)}</td>
<td><form method="post" action="/admin/shipments/${s.id}/events" class="row" style="gap:4px"><select name="status" style="width:150px">${SHIPMENT_STATUSES.map((st) => html`<option value="${st}" ${st === s.status ? 'selected' : ''}>${SHIPMENT_STATUS_LABELS[st]}</option>`)}</select><input name="location" placeholder="Plats" style="width:120px"><button type="submit" class="secondary">Registrera</button></form></td>
</tr>`)}</table>`}
</div>
<p class="small muted">Statusen "Levererad" markerar även ordern som levererad. Transportörens webhook kan skicka samma händelser till <span class="mono">POST /api/v1/shipments/tracking/&lt;kollinummer&gt;/events</span>.</p>
`, { path: '/admin/shipments', msg: data.msg, err: data.err });
}

export function shipmentDetailFragment(s: ShipmentDetail): Html {
  return html`<ul class="timeline">${s.events.map((e) => html`<li><span class="t">${fmtDate(e.occurredAt)}</span>${SHIPMENT_STATUS_LABELS[e.status] ?? e.status}${e.location ? ` – ${e.location}` : ''}${e.description ? html` <span class="muted">${e.description}</span>` : ''}</li>`)}</ul>`;
}

/* ---------- Prenumerationer ---------- */

export function subscriptionBadge(status: SubscriptionStatus): Html {
  return html`<span class="badge ${status}">${SUBSCRIPTION_STATUS_LABELS[status]}</span>`;
}

export function subscriptionsPage(staff: StaffUser, data: { subscriptions: SubscriptionListItem[]; waves: WaveSummary[]; waveMode: string; status?: string; q?: string; msg?: string; err?: string }): Html {
  const filter = (value: string | undefined, label: string) =>
    html`<a href="/admin/subscriptions${value ? `?status=${value}` : ''}" class="${(data.status ?? '') === (value ?? '') ? 'active' : ''}">${label}</a>`;
  const nowIso = new Date().toISOString();
  return layout(staff, 'Prenumerationer', html`
<h1>Prenumerationer</h1>
<div class="filters">${filter(undefined, 'Alla')}${filter('active', 'Aktiva')}${filter('paused', 'Pausade')}${filter('cancelled', 'Avslutade')}
<form method="post" action="/admin/subscriptions/renew-due" style="margin-left:0"><button type="submit" class="secondary">Skapa förfallna månadsordrar nu</button></form>
<form method="get" action="/admin/subscriptions"><input type="search" name="q" placeholder="Sök namn, e-post, referens…" value="${data.q ?? ''}"><button type="submit" class="secondary">Sök</button></form></div>
<div class="card">
${data.subscriptions.length === 0 ? html`<p class="muted">Inga prenumerationer.</p>` : html`<table>
<tr><th>#</th><th>Kund</th><th>Box</th><th>Grupp</th><th>Status</th><th>Nästa box</th><th>Senast</th><th class="num">Pris/mån</th><th class="num">Ordrar</th></tr>
${data.subscriptions.map((s) => html`<tr>
<td><a href="/admin/subscriptions/${s.id}">#${s.id}</a>${s.externalRef ? html`<div class="small muted mono">${s.externalRef}</div>` : ''}</td>
<td><a href="/admin/customers/${s.customerId}">${s.customerName}</a><div class="small muted">${s.customerEmail}</div></td>
<td>${s.boxSize} dosor × ${s.quantity}</td>
<td class="small">${data.waveMode === 'single' ? html`<span class="muted">Alla samtidigt</span>` : `Våg ${s.wave}`}</td>
<td>${subscriptionBadge(s.status)}${s.lastError ? html`<div class="small" style="color:var(--danger)">${s.lastError}</div>` : ''}</td>
<td class="small">${fmtDate(s.nextRenewalAt)}${s.status === 'active' && s.nextRenewalAt <= nowIso ? html` <span class="badge pending">Förfallen</span>` : ''}</td>
<td class="small">${fmtDate(s.lastRenewedAt)}</td><td class="num">${formatSek(s.priceOre)}</td><td class="num">${s.orderCount}</td>
</tr>`)}</table>`}
</div>
<div class="card">
<h2 style="margin-top:0">Utskicksvågor</h2>
<p class="small muted">Alla kunder får samma box. Vågen styr bara vilken dag den skickas. Läget sätts med <span class="mono">SHIPPING_WAVE_MODE</span> i .env (<span class="mono">single</span> = alla samtidigt, <span class="mono">weekly</span> = fyra grupper).
Nuvarande läge: <strong>${data.waveMode === 'weekly' ? 'veckovis i fyra grupper' : 'alla samtidigt'}</strong>.</p>
<table><tr><th>Grupp</th><th>Dag i månaden</th><th class="num">Aktiva</th><th class="num">Pausade</th><th>Nästa utskick</th></tr>
${data.waves.map((w) => html`<tr><td>${w.label}</td><td>${w.dayOfMonth}</td><td class="num">${w.active}</td><td class="num">${w.paused}</td><td class="small">${fmtDate(w.nextRenewalAt)}</td></tr>`)}
</table>
<form method="post" action="/admin/waves/assign" class="actions" onsubmit="return confirm('Fördela om alla prenumeranter efter när de gick med?')"><button type="submit" class="secondary">Fördela prenumeranter i vågor efter startdatum</button></form>
</div>
<p class="small muted">Månadsordrar skapas automatiskt av servern när förnyelsedatumet passerat, eller via <span class="mono">POST /api/v1/subscriptions/:id/renew</span> från betalleverantörens webhook.</p>
`, { path: '/admin/subscriptions', msg: data.msg, err: data.err });
}

export function subscriptionPage(staff: StaffUser, sub: Subscription, customer: Customer, orders: OrderListItem[], opts: { msg?: string; err?: string } = {}): Html {
  const action = (name: string, label: string, cls = '') =>
    html`<form class="inline" method="post" action="/admin/subscriptions/${sub.id}/actions/${name}"><button type="submit" class="${cls}">${label}</button></form>`;
  return layout(staff, `Prenumeration #${sub.id}`, html`
<h1>Prenumeration #${sub.id} ${subscriptionBadge(sub.status)}</h1>
<div class="card no-print"><h2 style="margin-top:0">Åtgärder</h2><div class="actions">
${sub.status !== 'cancelled' ? action('renew', 'Skapa månadens order nu') : ''}
${sub.status === 'active' ? action('pause', 'Pausa', 'secondary') : ''}
${sub.status === 'paused' ? action('resume', 'Återuppta') : ''}
${sub.status !== 'cancelled' ? html`<form class="inline" method="post" action="/admin/subscriptions/${sub.id}/actions/cancel" onsubmit="return confirm('Avsluta prenumerationen?')"><button type="submit" class="danger">Avsluta</button></form>` : ''}
</div>${sub.lastError ? html`<p style="color:var(--danger)">Senaste förnyelsen misslyckades: ${sub.lastError}</p>` : ''}</div>
<div class="grid cols-2">
<div class="card"><h2 style="margin-top:0">Inställningar</h2>
<form method="post" action="/admin/subscriptions/${sub.id}">
<div class="row"><div class="field"><label>Dosor/box</label><input type="number" name="boxSize" value="${sub.boxSize}" min="1"></div><div class="field"><label>Antal boxar</label><input type="number" name="quantity" value="${sub.quantity}" min="1"></div>
<div class="field"><label>Utskicksgrupp</label><select name="wave">${[1, 2, 3, 4].map((w) => html`<option value="${w}" ${sub.wave === w ? 'selected' : ''}>Våg ${w}</option>`)}</select></div></div>
<div class="row"><div class="field"><label>Pris/period (kr)</label><input type="number" step="0.01" name="priceKr" value="${(sub.priceOre / 100).toFixed(2)}"></div><div class="field"><label>Intervall (mån)</label><input type="number" name="intervalMonths" value="${sub.intervalMonths}" min="1" max="12"></div>
<div class="field"><label>Nästa box</label><input type="date" name="nextRenewalDate" value="${sub.nextRenewalAt.slice(0, 10)}"></div></div>
<div class="row"><div class="field"><label>Betalsätt</label><input name="paymentMethod" value="${sub.paymentMethod ?? ''}"></div><div class="field"><label>Referens hos betalleverantör</label><input name="externalRef" value="${sub.externalRef ?? ''}"></div></div>
<div class="field"><label>Anteckningar</label><textarea name="notes">${sub.notes ?? ''}</textarea></div>
<div class="actions"><button type="submit">Spara</button></div></form>
<p class="small muted">Innehållet i boxen bestäms av <a href="/admin/editions">månadens box</a> och är detsamma för alla kunder.</p>
<dl style="margin-top:12px"><dt>Kund</dt><dd><a href="/admin/customers/${customer.id}">${fullName(customer)}</a> · ${customer.email}</dd><dt>Startad</dt><dd>${fmtDate(sub.startedAt)}</dd><dt>Senast förnyad</dt><dd>${fmtDate(sub.lastRenewedAt)}</dd>${sub.cancelledAt ? html`<dt>Avslutad</dt><dd>${fmtDate(sub.cancelledAt)}</dd>` : ''}</dl>
</div>
<div class="card"><h2 style="margin-top:0">Skapade ordrar</h2>${orderTable(orders, { compact: true })}</div>
</div>`, { path: '/admin/subscriptions', ...opts });
}
