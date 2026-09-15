import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { config } from '../../config.ts';
import { formatSek } from '../../domain/money.ts';
import { STRENGTH_LABELS } from '../../domain/products.ts';
import { SENTIMENT_LABELS } from '../../domain/ratings.ts';
import type { StaffUser } from '../../services/auth.ts';
import { EDITION_STATUS_LABELS, periodLabel, type EditionDetail, type EditionForecast, type EditionListItem, type EditionStatus } from '../../services/editions.ts';
import type { Product } from '../../services/products.ts';
import type { Supplier } from '../../services/suppliers.ts';
import type { EditionReport } from '../../services/reports.ts';
import type { RatingComment } from '../../services/ratings.ts';
import { fmtDate, layout } from './views.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function editionBadge(status: EditionStatus): Html {
  const cls = status === 'locked' ? 'delivered' : status === 'archived' ? 'cancelled' : 'pending';
  return html`<span class="badge ${cls}">${EDITION_STATUS_LABELS[status]}</span>`;
}

function stars(average: number | null): string {
  if (average == null) return '–';
  const filled = Math.floor(average);
  return `${'★'.repeat(filled)}${'☆'.repeat(Math.max(0, 5 - filled))} ${average.toFixed(1)}`;
}

export function editionsPage(
  staff: StaffUser,
  data: { editions: EditionListItem[]; suggestedPeriod: string; msg?: string; err?: string },
): Html {
  return layout(staff, 'Månadsboxar', html`
<h1>Månadsboxar</h1>
<p class="muted">Alla kunder får samma innehåll en viss månad. Sätt ihop boxen här, lås den innan plockningen startar, och följ sedan upp hur den togs emot.</p>
<div class="card">
<h2 style="margin-top:0">Ny box</h2>
<form method="post" action="/admin/editions" class="row">
  <div class="field"><label>Period (ÅÅÅÅ-MM)</label><input name="period" value="${data.suggestedPeriod}" pattern="\\d{4}-\\d{2}" required></div>
  <div class="field" style="flex:2"><label>Namn</label><input name="name" placeholder="Lämna tomt för automatiskt namn"></div>
  <div class="field" style="flex:2"><label>Tema / beskrivning</label><input name="description"></div>
  <div class="field" style="flex:0"><button type="submit">Skapa</button></div>
</form>
</div>
<div class="card">
${data.editions.length === 0 ? html`<p class="muted">Ingen box är skapad ännu.</p>` : html`<table>
<tr><th>Period</th><th>Namn</th><th>Status</th><th class="num">Produkter</th><th class="num">Dosor</th><th class="num">Ordrar</th><th class="num">Betyg</th><th>Skapad</th></tr>
${data.editions.map((e) => html`<tr>
<td><a href="/admin/editions/${e.id}" class="mono">${e.period}</a></td>
<td>${e.name}${e.description ? html`<div class="small muted">${e.description}</div>` : ''}</td>
<td>${editionBadge(e.status)}</td>
<td class="num">${e.itemCount}</td>
<td class="num">${e.totalCans}${e.totalCans !== config.defaultBoxSize ? html` <span class="badge low">≠ ${config.defaultBoxSize}</span>` : ''}</td>
<td class="num">${e.orderCount}</td>
<td class="num">${e.ratingCount > 0 ? html`<a href="/admin/editions/${e.id}/report">${e.ratingCount}</a>` : '0'}</td>
<td class="small">${fmtDate(e.createdAt)}</td>
</tr>`)}
</table>`}
</div>
`, { path: '/admin/editions', msg: data.msg, err: data.err });
}

export function editionPage(
  staff: StaffUser,
  edition: EditionDetail,
  products: Product[],
  forecast: EditionForecast,
  opts: { msg?: string; err?: string } = {},
): Html {
  const editable = edition.status === 'draft';
  const complete = edition.totalCans === config.defaultBoxSize;
  return layout(staff, `Box ${edition.period}`, html`
<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
  <h1 style="margin:0">${edition.name} ${editionBadge(edition.status)}</h1>
  <div><a class="btn secondary" href="/admin/editions/${edition.id}/report">Rapport & betyg</a></div>
</div>
<p class="muted">Boxen för ${periodLabel(edition.period)}. Innehållet är detsamma för alla kunder.</p>

<div class="grid cols-2">
<div class="card">
<h2 style="margin-top:0">Innehåll (${edition.totalCans} av ${config.defaultBoxSize} dosor)</h2>
${edition.items.length === 0 ? html`<p class="muted">Inga produkter valda ännu.</p>` : html`<table>
<tr><th>Produkt</th><th>Smak / styrka</th><th>Leverantör</th><th class="num">Antal</th>${editable ? html`<th></th>` : ''}</tr>
${edition.items.map((i) => html`<tr>
<td><a href="/admin/products/${i.productId}" class="mono">${i.sku}</a><div>${i.brand} ${i.productName}</div></td>
<td class="small">${i.flavor} · ${STRENGTH_LABELS[i.strength]}</td>
<td class="small">${i.supplierName ?? html`<span class="muted">–</span>`}</td>
<td class="num">${editable
  ? html`<form method="post" action="/admin/editions/${edition.id}/items" class="row" style="gap:4px;justify-content:flex-end"><input type="hidden" name="productId" value="${i.productId}"><input type="number" name="quantity" value="${i.quantity}" min="0" style="width:70px"><button type="submit" class="secondary">Spara</button></form>`
  : i.quantity}</td>
${editable ? html`<td><form method="post" action="/admin/editions/${edition.id}/items"><input type="hidden" name="productId" value="${i.productId}"><input type="hidden" name="quantity" value="0"><button type="submit" class="secondary" title="Ta bort">✕</button></form></td>` : ''}
</tr>`)}
</table>`}
${editable ? html`
<h3>Lägg till produkt</h3>
<form method="post" action="/admin/editions/${edition.id}/items" class="row">
  <div class="field" style="flex:3"><select name="productId" required><option value="">Välj produkt…</option>${products.map((p) => html`<option value="${p.id}">${p.sku} – ${p.brand} ${p.name} (${p.stockOnHand - p.stockReserved} i lager)</option>`)}</select></div>
  <div class="field" style="max-width:100px"><input type="number" name="quantity" value="1" min="1"></div>
  <div class="field" style="flex:0"><button type="submit">Lägg till</button></div>
</form>` : ''}
<div class="actions">
${editable
  ? html`<form class="inline" method="post" action="/admin/editions/${edition.id}/lock"><button type="submit" ${complete ? '' : 'disabled'}>Lås boxen för plockning</button></form>${complete ? '' : html`<span class="small muted" style="align-self:center">Boxen måste innehålla exakt ${config.defaultBoxSize} dosor</span>`}`
  : edition.status === 'locked'
    ? html`<form class="inline" method="post" action="/admin/editions/${edition.id}/unlock"><button type="submit" class="secondary">Lås upp för ändring</button></form>`
    : ''}
${edition.status !== 'archived' ? html`<form class="inline" method="post" action="/admin/editions/${edition.id}/archive" onsubmit="return confirm('Arkivera boxen?')"><button type="submit" class="secondary">Arkivera</button></form>` : ''}
</div>
</div>

<div>
<div class="card">
<h2 style="margin-top:0">Behov och lager</h2>
<p class="small muted">${forecast.boxesNeeded} aktiva prenumerationer · ${forecast.ordersCreated} ordrar skapade för den här boxen</p>
${forecast.rows.length === 0 ? html`<p class="muted">Lägg till produkter för att se behovet.</p>` : html`<table>
<tr><th>Produkt</th><th class="num">Per box</th><th class="num">Behövs</th><th class="num">Tillgängligt</th><th class="num">Saknas</th></tr>
${forecast.rows.map((r) => html`<tr><td class="mono">${r.sku}</td><td class="num">${r.perBox}</td><td class="num">${r.needed}</td><td class="num">${r.available}</td><td class="num">${r.shortfall > 0 ? html`<span class="badge low">${r.shortfall}</span>` : '0'}</td></tr>`)}
</table>`}
${forecast.totalShortfall > 0 ? html`<p style="color:var(--danger)">Det saknas ${forecast.totalShortfall} dosor för att fylla alla boxar. Köp in innan plockningen startar.</p>` : forecast.rows.length ? html`<p class="small" style="color:var(--accent)">Lagret räcker till alla prenumeranter.</p>` : ''}
</div>

<div class="card">
<h2 style="margin-top:0">Namn och tema</h2>
<form method="post" action="/admin/editions/${edition.id}">
<div class="field"><label>Namn</label><input name="name" value="${edition.name}"></div>
<div class="field"><label>Tema / beskrivning</label><textarea name="description">${edition.description ?? ''}</textarea></div>
<div class="actions"><button type="submit" class="secondary">Spara</button></div>
</form>
${edition.lockedAt ? html`<p class="small muted">Låst ${fmtDate(edition.lockedAt)}</p>` : ''}
</div>
</div>
</div>
`, { path: '/admin/editions', ...opts });
}

export function editionReportPage(
  staff: StaffUser,
  report: EditionReport,
  suppliers: Supplier[],
  comments: RatingComment[],
  opts: { supplierId?: number; msg?: string; err?: string } = {},
): Html {
  const csvHref = `/admin/editions/${report.edition.id}/report.csv${opts.supplierId ? `?supplierId=${opts.supplierId}` : ''}`;
  return layout(staff, `Rapport ${report.edition.period}`, html`
<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
  <h1 style="margin:0">Rapport – ${report.edition.name}</h1>
  <div><a class="btn" href="${csvHref}">Ladda ner CSV</a> <a class="btn secondary" href="/admin/editions/${report.edition.id}">Till boxen</a></div>
</div>

<div class="grid cols-4">
  <div class="card stat"><div class="n">${report.boxesShipped}</div><div class="l">Boxar skickade</div></div>
  <div class="card stat"><div class="n">${report.ratedCustomers}</div><div class="l">Kunder som betygsatt</div></div>
  <div class="card stat"><div class="n">${stars(report.boxRating.average)}</div><div class="l">Helhetsbetyg (${report.boxRating.responses} svar)</div></div>
  <div class="card stat"><div class="n">${report.products.reduce((s, p) => s + p.clicks, 0)}</div><div class="l">Klick till återförsäljare</div></div>
</div>

<div class="card">
<form method="get" class="row" style="margin-bottom:12px">
  <div class="field" style="max-width:280px"><label>Visa bara en leverantör</label>
    <select name="supplierId" onchange="this.form.submit()">
      <option value="">Alla leverantörer</option>
      ${suppliers.map((s) => html`<option value="${s.id}" ${opts.supplierId === s.id ? 'selected' : ''}>${s.name}</option>`)}
    </select></div>
  <div class="field" style="flex:0"><button type="submit" class="secondary">Visa</button></div>
</form>
${report.products.length === 0 ? html`<p class="muted">Inga produkter att visa.</p>` : html`<table>
<tr><th>Produkt</th><th>Leverantör</th><th class="num">Dosor ut</th><th class="num">Svar</th><th>Betyg</th><th class="num">Gillar</th><th class="num">Ogillar</th><th class="num">Köper igen</th><th class="num">Klick</th><th class="num">Köp</th></tr>
${report.products.map((p) => html`<tr>
<td><a href="/admin/products/${p.productId}" class="mono">${p.sku}</a><div class="small">${p.brand} ${p.productName}</div></td>
<td class="small">${p.supplierName ?? html`<span class="muted">–</span>`}</td>
<td class="num">${p.cansShipped}</td>
<td class="num">${p.responses}</td>
<td>${stars(p.averageRating)}</td>
<td class="num">${p.likes}${p.likes + p.dislikes + p.neutral > 0 ? html` <span class="small muted">${p.likeSharePercent}%</span>` : ''}</td>
<td class="num">${p.dislikes}</td>
<td class="num">${p.wouldBuyAgain}${p.responses > 0 ? html` <span class="small muted">${p.wouldBuyAgainSharePercent}%</span>` : ''}</td>
<td class="num">${p.clicks}${p.clickCustomers > 0 ? html` <span class="small muted">${p.clickCustomers} st</span>` : ''}</td>
<td class="num">${p.conversions}${p.conversionValueOre > 0 ? html`<div class="small muted">${formatSek(p.conversionValueOre)}</div>` : ''}</td>
</tr>`)}
</table>`}
<p class="small muted">"Klick" är kunder som gått vidare till en återförsäljare för att köpa mer. "Köp" räknas när återförsäljaren rapporterat tillbaka att klicket ledde till ett köp.</p>
</div>

<div class="card">
<h2 style="margin-top:0">Kommentarer (${comments.length})</h2>
${comments.length === 0 ? html`<p class="muted">Inga kommentarer ännu.</p>` : html`<ul class="timeline">
${comments.map((c) => html`<li><span class="t">${fmtDate(c.createdAt)}</span><a href="/admin/customers/${c.customerId}">${c.customerName}</a>${c.rating ? html` · ${c.rating}/5` : ''}${c.sentiment ? html` · ${SENTIMENT_LABELS[c.sentiment]}` : ''}<br>${c.comment}</li>`)}
</ul>`}
</div>
`, { path: '/admin/editions', msg: opts.msg, err: opts.err });
}
