import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatSek } from '../../domain/money.ts';
import type { StaffUser } from '../../services/auth.ts';
import type { Product } from '../../services/products.ts';
import type { RetailerLinkView, RetailerListItem } from '../../services/retailers.ts';
import type { Supplier } from '../../services/suppliers.ts';
import { layout } from './views.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function retailersPage(
  staff: StaffUser,
  data: { retailers: RetailerListItem[]; links: RetailerLinkView[]; products: Product[]; publicBaseUrl: string; msg?: string; err?: string },
): Html {
  return layout(staff, 'Återförsäljare', html`
<h1>Återförsäljare</h1>
<p class="muted">Gillar kunden ett snus i boxen kan hen klicka sig vidare hit för att köpa mer. Varje klick loggas på kundens profil och den månadens box, så att det syns i rapporten till leverantören.</p>

<div class="grid cols-2">
<div class="card">
<h2 style="margin-top:0">Butiker</h2>
${data.retailers.length === 0 ? html`<p class="muted">Ingen återförsäljare tillagd.</p>` : html`<table>
<tr><th>Namn</th><th>Webbplats</th><th class="num">Länkar</th><th class="num">Klick</th><th class="num">Köp</th><th>Status</th></tr>
${data.retailers.map((r) => html`<tr>
<td>${r.name}</td>
<td class="small">${r.website ? html`<a href="${r.website}" target="_blank" rel="noopener">${r.website}</a>` : html`<span class="muted">–</span>`}</td>
<td class="num">${r.linkCount}</td><td class="num">${r.clicks}</td><td class="num">${r.conversions}</td>
<td>${r.active ? html`<span class="badge delivered">Aktiv</span>` : html`<span class="badge cancelled">Av</span>`}</td>
</tr>`)}
</table>`}
<h3>Ny återförsäljare</h3>
<form method="post" action="/admin/retailers" class="row">
  <div class="field"><label>Namn</label><input name="name" required></div>
  <div class="field" style="flex:2"><label>Webbplats</label><input name="website" placeholder="https://"></div>
  <div class="field" style="flex:0"><button type="submit">Lägg till</button></div>
</form>
</div>

<div class="card">
<h2 style="margin-top:0">Köplänk per produkt</h2>
<form method="post" action="/admin/retailers/links">
<div class="row">
  <div class="field"><label>Butik</label><select name="retailerId" required>${data.retailers.filter((r) => r.active).map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></div>
  <div class="field" style="flex:2"><label>Produkt</label><select name="productId" required>${data.products.map((p) => html`<option value="${p.id}">${p.sku} – ${p.brand} ${p.name}</option>`)}</select></div>
</div>
<div class="row">
  <div class="field" style="flex:3"><label>Adress till produkten hos butiken</label><input name="url" placeholder="https://butiken.se/produkt" required></div>
  <div class="field" style="max-width:130px"><label>Pris där (kr)</label><input type="number" step="0.01" name="priceKr"></div>
  <div class="field" style="flex:0"><button type="submit">Spara länk</button></div>
</div>
</form>
${data.publicBaseUrl ? '' : html`<p class="small" style="color:var(--warn)">PUBLIC_BASE_URL är inte satt i .env, så spårningslänkarna nedan saknar domän. Sätt den till adressen där systemet nås utifrån.</p>`}
</div>
</div>

<div class="card">
<h2 style="margin-top:0">Alla köplänkar</h2>
${data.links.length === 0 ? html`<p class="muted">Inga länkar ännu.</p>` : html`<table>
<tr><th>Produkt</th><th>Butik</th><th class="num">Pris</th><th>Spårningslänk att använda på hemsidan</th><th class="num">Klick</th><th class="num">Köp</th><th></th></tr>
${data.links.map((l) => html`<tr>
<td class="mono">${l.sku}<div class="small">${l.brand} ${l.productName}</div></td>
<td>${l.retailerName}<div class="small muted"><a href="${l.url}" target="_blank" rel="noopener">Öppna butikslänk</a></div></td>
<td class="num">${l.priceOre == null ? '–' : formatSek(l.priceOre)}</td>
<td class="mono small">${l.trackingUrl}</td>
<td class="num">${l.clicks}</td><td class="num">${l.conversions}</td>
<td><form method="post" action="/admin/retailers/links/${l.id}/delete" onsubmit="return confirm('Ta bort länken?')"><button type="submit" class="secondary">✕</button></form></td>
</tr>`)}
</table>`}
<p class="small muted">Hemsidan hämtar färdiga länkar via <span class="mono">GET /api/v1/editions/:id/retail-links?customerToken=…</span> och behöver inte bygga dem själv.</p>
</div>
`, { path: '/admin/retailers', msg: data.msg, err: data.err });
}

export function suppliersPage(
  staff: StaffUser,
  data: { suppliers: (Supplier & { productCount: number })[]; msg?: string; err?: string },
): Html {
  return layout(staff, 'Leverantörer', html`
<h1>Leverantörer</h1>
<p class="muted">Leverantören kopplas till produkterna och används för att filtrera rapporten innan den delas. Varje leverantör ska bara se sina egna produkter.</p>
<div class="card">
${data.suppliers.length === 0 ? html`<p class="muted">Ingen leverantör tillagd.</p>` : html`<table>
<tr><th>Namn</th><th>Kontakt</th><th>E-post</th><th class="num">Produkter</th></tr>
${data.suppliers.map((s) => html`<tr><td>${s.name}</td><td>${s.contactName ?? '–'}</td><td class="small">${s.contactEmail ?? '–'}</td><td class="num">${s.productCount}</td></tr>`)}
</table>`}
<h3>Ny leverantör</h3>
<form method="post" action="/admin/suppliers" class="row">
  <div class="field"><label>Namn</label><input name="name" required></div>
  <div class="field"><label>Kontaktperson</label><input name="contactName"></div>
  <div class="field"><label>E-post</label><input type="email" name="contactEmail"></div>
  <div class="field" style="flex:0"><button type="submit">Lägg till</button></div>
</form>
</div>
<p class="small muted">Koppla produkter till en leverantör på respektive produktsida.</p>
`, { path: '/admin/products', msg: data.msg, err: data.err });
}
