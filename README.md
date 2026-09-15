# Mysterysnus OMS

Order-, kund- och logistiksystem för [Mysterysnus.se](https://mysterysnus.se). Systemet är
"back office"-delen: det tar emot ordrar från webbshopen (eller skapade manuellt), håller
koll på kunder, lager och mystery-boxarnas innehåll, och följer varje försändelse tills den
är levererad.

## Innehåll

- **Ordrar** – statusflöde `Väntar på betalning → Betald → Plockas → Packad → Skickad → Levererad`
  (plus Avbruten/Returnerad), orderhistorik, packsedel, intern anteckning, återbetalningskö.
- **Mystery-boxar** – innehållet föreslås automatiskt vid plockning utifrån lager, kundens
  styrke- och smakpreferenser, uteslutna smaker och vad kunden redan fått tidigare. Kan
  justeras manuellt innan packning.
- **Kunder** – kontaktuppgifter, leveransadress, preferenser, samtycke, spärr och
  ålderskontroll (18 år) vid varje order.
- **Produkter & lager** – saldo, reservationer (dras vid packning), lagerhistorik,
  varning för lågt lager.
- **Logistik** – försändelser per order, transportör (PostNord, DHL, Budbee, Instabox,
  Bring, DB Schenker), kollinummer med spårningslänk, statushändelser och webhook-endpoint
  för transportörens uppdateringar. "Levererad" från transportören stänger ordern.
- **Etiketter** – pluggbar etikettleverantör (`LABEL_PROVIDER=manual|nshift|postnord`).
  Med en leverantör kopplad bokas försändelsen automatiskt när ordern skickas, kollinumret
  fylls i och etiketten (PDF) kan skrivas ut från orderns sida. Se "Etikettutskrift" nedan.
- **Admin-gränssnitt** på `/admin` (inloggning för personal med roller) och **JSON-API**
  på `/api/v1` (API-nyckel för webbshopen/integrationer).

## Teknik

- Node.js ≥ 22.18 med inbyggt TypeScript-stöd (ingen byggsteg) och inbyggd SQLite (`node:sqlite`).
- [Hono](https://hono.dev) för HTTP, [Zod](https://zod.dev) för validering.
- Alla belopp lagras i **öre** (heltal), priser inkl. 25 % moms.

```
src/
  config.ts          Inställningar (port, databas, frakt, boxpriser, moms …)
  db/                Schema/migrationer, anslutning, seed
  domain/            Ren affärslogik: statusmaskin, vågor, betyg, pengar, transportörer
  logistics/         Etikettleverantörer (gränssnitt + nShift/PostNord)
  services/          Kunder, produkter, lager, månadsboxar, ordrar, prenumerationer,
                     försändelser, etiketter, betyg, återförsäljare, rapporter, auth
  http/api/          JSON-API
  http/admin/        Admin-gränssnitt (server-renderad HTML)
  test/              Tester (node:test)
```

## Kom igång

Systemet körs på din egen dator eller server – det finns ingen publik adress förrän du
driftsätter det. Två sätt:

**Med Node.js (kräver Node 22.18 eller nyare, se https://nodejs.org):**

```bash
git clone <repo> && cd <repo>
npm install
cp .env.example .env        # justera värden
npm run seed                # skapar admin-konto + exempeldata (ej i produktion)
npm run dev                 # öppna http://localhost:3000/admin
```

**Med Docker (inget Node behövs):**

```bash
cp .env.example .env        # sätt minst API_KEY och ADMIN_PASSWORD
docker compose up --build   # öppna http://localhost:3000/admin
```

Vid första starten i Docker skapas admin-kontot av `ADMIN_EMAIL`/`ADMIN_PASSWORD`
(kör `docker compose exec oms node src/db/seed.ts` för att lägga in exempeldata).

Standardinloggning (om `ADMIN_EMAIL`/`ADMIN_PASSWORD` inte satts i `.env`):
`admin@mysterysnus.se` / `admin123` – byt direkt. Servern skapar kontot själv vid start om
det saknas, så det går att logga in även om `npm run seed` hoppats över.
Värden i `.env` läses in automatiskt av alla `npm run`-kommandon.

Övriga kommandon: `npm test`, `npm run typecheck`, `npm run migrate`, `npm start`.

## API

Alla anrop (utom `/api/v1/health`) kräver headern `X-API-Key: <API_KEY>` eller en inloggad
personal-session. Svar är JSON; fel har formen `{ "error": { "code", "message", "details?" } }`.

| Metod | Sökväg | Beskrivning |
| --- | --- | --- |
| `GET/POST` | `/api/v1/customers` | Lista/sök eller skapa kund |
| `GET/PATCH` | `/api/v1/customers/:id` | Hämta/uppdatera kund (`status: blocked` spärrar) |
| `GET` | `/api/v1/customers/:id/orders` | Kundens ordrar |
| `GET/POST` | `/api/v1/products` | Lista (`?q=&active=true&lowStock=true`) eller skapa produkt |
| `GET/PATCH` | `/api/v1/products/:id` | Hämta/uppdatera produkt |
| `POST` | `/api/v1/products/:id/stock` | Justera saldo `{ delta, reason, note }` |
| `GET` | `/api/v1/products/:id/movements` | Lagerhistorik |
| `GET/POST` | `/api/v1/orders` | Lista (`?status=paid,picking&q=&customerId=`) eller skapa order |
| `GET` | `/api/v1/orders/stats` | Antal per status |
| `GET` | `/api/v1/orders/:id`, `/api/v1/orders/number/:nr` | Orderdetalj med rader, boxinnehåll, försändelser, historik |
| `POST` | `/api/v1/orders/:id/pay` | Markera betald `{ paymentRef?, paymentMethod? }` |
| `POST` | `/api/v1/orders/:id/pick` | Starta plockning, föreslå boxinnehåll |
| `PUT` | `/api/v1/orders/:id/lines/:lineId/picks` | Ersätt boxinnehåll `{ picks: [{ productId, quantity }] }` |
| `POST` | `/api/v1/orders/:id/pack` | Bekräfta packning (lagret dras) |
| `POST` | `/api/v1/orders/:id/ship` | Skapa försändelse `{ carrier, service?, trackingNumber?, weightGrams?, pickupPoint? }` |
| `POST` | `/api/v1/orders/:id/deliver` · `/cancel` · `/return` · `/refund` · `/reopen` · `/cancel-picking` | Övriga statusövergångar |
| `PATCH` | `/api/v1/orders/:id` | Intern anteckning |
| `GET/POST` | `/api/v1/editions` | Lista månadsboxar eller skapa en `{ period, name?, description? }` |
| `GET` | `/api/v1/editions/period/:period` | Hämta boxen för en månad (ÅÅÅÅ-MM) |
| `PUT` | `/api/v1/editions/:id/items` | Sätt innehållet `{ items: [{ productId, quantity }] }` |
| `POST` | `/api/v1/editions/:id/lock` · `/unlock` · `/archive` | Lås innehållet inför plockning |
| `GET` | `/api/v1/editions/:id/forecast` | Behov per produkt och vad som saknas i lager |
| `GET` | `/api/v1/editions/:id/report` · `report.csv` | Loggdata till leverantör (`?supplierId=`) |
| `GET` | `/api/v1/editions/:id/retail-links` | Köplänkar för allt i boxen (`?customerToken=`) |
| `POST` | `/api/v1/ratings` | Betygsätt en produkt `{ customerToken\|customerId, period\|editionId, productId, rating?, sentiment?, wouldBuyAgain?, comment? }` |
| `POST` | `/api/v1/ratings/box` | Helhetsbetyg på månadens box |
| `GET` | `/api/v1/ratings` | Kundens betyg (`?customerToken=&period=`) |
| `GET/POST` | `/api/v1/retailers` | Lista eller skapa återförsäljare |
| `PUT` | `/api/v1/retailers/links` | Köplänk `{ retailerId, productId, url, priceOre? }` |
| `POST` | `/api/v1/retailers/conversions` | Butiken rapporterar köp `{ ref, valueOre? }` |
| `GET` | `/api/v1/retailers/stats` | Klick och köp per produkt och butik |
| `GET/POST` | `/api/v1/suppliers` | Leverantörer |
| `GET` | `/api/v1/products/:id/retailers` · `/history` | Köplänkar respektive mottagande över tid |
| `GET` | `/r/:linkId?t=&p=` | **Publik** – loggar klicket och skickar kunden till butiken |
| `GET/POST` | `/api/v1/subscriptions` | Lista (`?status=&customerId=`) eller skapa prenumeration `{ customerId, boxSize?, strength?, priceOre?, startAt?, externalRef? }` |
| `GET/PATCH` | `/api/v1/subscriptions/:id` | Hämta (med ordrar) / ändra box, styrka, pris, nästa datum |
| `POST` | `/api/v1/subscriptions/:id/renew` | Skapa periodens order `{ period?, paymentStatus?, paymentRef? }` – idempotent, tänkt för betalleverantörens webhook |
| `POST` | `/api/v1/subscriptions/:id/pause` · `/resume` · `/cancel` | Statusändringar |
| `POST` | `/api/v1/subscriptions/renew-due` | Skapa ordrar för alla förfallna prenumerationer (cron) |
| `GET` | `/api/v1/subscriptions/external/:ref` | Slå upp via betalleverantörens id |
| `GET` | `/api/v1/shipments` | Lista (`?status=&carrier=&q=`) |
| `GET/PATCH` | `/api/v1/shipments/:id` | Hämta/uppdatera (kollinummer m.m.) |
| `POST` | `/api/v1/shipments/:id/events` | Registrera händelse |
| `POST/GET` | `/api/v1/shipments/:id/label` | Boka hos etikettleverantören / ladda ner etiketten |
| `GET` | `/api/v1/shipments/tracking/:nr` | Slå upp via kollinummer |
| `POST` | `/api/v1/shipments/tracking/:nr/events` | Webhook: händelse via kollinummer `{ status, description?, location?, occurredAt? }` |

### Exempel: webbshopen skickar in en betald order

```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "externalRef": "SHOP-1042",
    "customer": { "email": "anna@example.com", "firstName": "Anna", "lastName": "Andersson",
                  "birthDate": "1988-03-12" },
    "shippingAddress": { "street": "Sveavägen 10", "postalCode": "111 57", "city": "Stockholm" },
    "lines": [
      { "kind": "mystery_box", "boxSize": 4, "quantity": 1 },
      { "kind": "product", "sku": "ZYN-COOL-MINT-S", "quantity": 2 }
    ],
    "paymentStatus": "paid", "paymentMethod": "klarna", "paymentRef": "KL-99812",
    "ageVerified": true
  }'
```

Kunden skapas om e-posten är ny, annars uppdateras adressen. `externalRef` skyddar mot dubbletter.
Webbshopen behöver inte veta vad som ligger i boxen: utelämnas `editionId` binds periodens
månadsbox automatiskt, och den bestämmer både antalet dosor och innehållet. Skicka `editionId: null`
för en fristående box utanför prenumerationen. Produktrader reserverar lager direkt.
Frakt beräknas enligt `config.shipping` om `shippingOre` utelämnas.

### Månadsboxen

1. Skapa boxen för nästa månad under **Månadsboxar**, lägg till fyra produkter och **lås** den.
   En låst box kan inte ändras så länge ordrar plockas mot den.
2. Prenumerationsordrarna för perioden fylls med exakt det innehållet. Behovsprognosen på
   boxsidan visar hur många dosor som krävs för alla aktiva prenumeranter och vad som saknas.
3. När boxarna skickats betygsätter kunderna innehållet från hemsidan. Rapporten per box
   sammanställer betyg, kommentarer och merköp och kan delas med respektive leverantör.

### Betyg och spårning från hemsidan

Hemsidan identifierar kunden med `publicToken` (en ogissbar sträng på kundkortet) och behöver
aldrig känna till interna id:n.

```bash
# Kundens betyg på en produkt i oktoberboxen
curl -X POST http://localhost:3000/api/v1/ratings \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{ "customerToken": "a1b2…", "period": "2026-10", "productId": 12,
        "rating": 5, "sentiment": "like", "wouldBuyAgain": true, "comment": "Bästa i boxen" }'

# Köplänkar för allt i boxen, färdiga att visa som "köp mer"-knappar
curl -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/editions/7/retail-links?customerToken=a1b2…"
```

Varje köplänk pekar på `/r/:linkId?t=<kundtoken>&p=<period>`. Systemet loggar klicket med kund,
produkt och månadsbox, lägger till en unik `ref` och skickar kunden vidare till butiken. När
butiken rapporterar `POST /api/v1/retailers/conversions { ref, valueOre }` räknas köpet i
rapporten. Klick från okända tokens loggas anonymt – länken fungerar alltid.

### Utskicksvågor

`SHIPPING_WAVE_MODE=single` (standard) skickar till alla samtidigt. `weekly` delar kunderna i
fyra grupper efter vilken del av månaden de gick med: dag 1–7 ger våg 1 som förnyas den 1:a,
dag 8–14 ger våg 2 som förnyas den 8:e, och så vidare. Byt läge i `.env` och kör sedan
**Fördela prenumeranter i vågor** på prenumerationssidan för att placera befintliga kunder.

### Prenumerationsflödet

1. Kunden tecknar prenumeration i webbshopen. Webbshopen anropar `POST /api/v1/subscriptions`
   med `externalRef` = betalleverantörens prenumerations-id (t.ex. Stripe `sub_…`).
2. Varje månad, när betalleverantören dragit pengarna (t.ex. Stripe `invoice.paid`), anropar
   webbshopen `POST /api/v1/subscriptions/:id/renew` med `paymentStatus: "paid"` och
   `paymentRef` = fakturans id. Ordern hamnar direkt i plockkön. Skickas webhooken om med
   samma `paymentRef` returneras den befintliga ordern.
3. Utan webhook skapar servern själv en **obetald** order när förnyelsedatumet passerat
   (körs varje timme). Den markeras betald i admin eller via `POST /api/v1/orders/:id/pay`.

Samma period (ÅÅÅÅ-MM) kan aldrig ge två ordrar.

### Etikettutskrift

Alla etikettleverantörer implementerar gränssnittet i `src/logistics/types.ts`:
`createLabel(request) → { trackingNumber, trackingUrl, providerRef, label: { format, data } }`.
Systemet sköter resten: sparar etiketten, sätter kollinummer och spårningslänk, loggar
händelsen och visar "Skriv ut etikett" i admin.

- `LABEL_PROVIDER=manual` (standard): kollinummer skrivs in för hand.
- `LABEL_PROVIDER=nshift`: `src/logistics/providers/nshift.ts`. Kräver `NSHIFT_API_ID`,
  `NSHIFT_API_SECRET`, `NSHIFT_SENDER_ID` samt tjänstekoder per transportör
  (`NSHIFT_SERVICE_POSTNORD` osv.). Bokar alla transportörer via ett API.
- `LABEL_PROVIDER=postnord`: `src/logistics/providers/postnord.ts`. Kräver `POSTNORD_API_KEY`
  och `POSTNORD_CUSTOMER_NUMBER`.

Båda integrationerna är förberedda med autentisering, request-mappning och felhantering, men
**inte testade mot leverantörernas riktiga API:er** – fältnamn och tjänstekoder ska verifieras
mot respektive dokumentation innan driftsättning. Avsändaradressen sätts med `SENDER_*`.
En ny leverantör = en ny fil under `providers/` + en rad i `src/logistics/index.ts`.

## Antaganden att bekräfta

Systemet är byggt utan tillgång till sajten, så några saker är gissningar som är lätta att ändra:

- Boxen är 4 dosor och kostar **249 kr/månad – ett platshållarpris**. Ändra i `src/config.ts`
  (`mysteryBoxPricesOre`) eller sätt priset per prenumeration.
- Betygsskalan är 1–5 plus gillar/ogillar och "skulle köpa igen". Vilka fält ni faktiskt visar
  på hemsidan avgör ni; alla är frivilliga i API:et.
- Bara kunder som fått en box kan betygsätta den. Boxen räknas som mottagen när ordern är betald
  och inte avbruten.
- Kundens styrke- och smakpreferenser finns kvar på kundkortet för segmentering, men styr inte
  längre innehållet i boxen eftersom alla får samma.
- Endast leverans inom Sverige och 25 % moms på allt.
- Betalning sker i webbshopen (Klarna/Swish/kort); systemet registrerar bara betalstatus och
  återbetalningsbehov, det utför inga betalningar.
- Vilken betalleverantör webbshopen använder avgör hur prenumerationsförnyelsen bäst kopplas
  (webhook eller intern schemaläggning – båda stöds).

## Drift

- Sätt `NODE_ENV=production`, `API_KEY` och `ADMIN_PASSWORD`. Servern vägrar starta i produktion utan API-nyckel.
- Kör bakom en TLS-terminerande proxy; sessionskakan sätts som `Secure` i produktion.
- Databasen är en enda SQLite-fil (`DATABASE_PATH`) i WAL-läge – säkerhetskopiera filen regelbundet.
