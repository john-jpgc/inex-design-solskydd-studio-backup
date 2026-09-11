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
  domain/            Ren affärslogik: statusmaskin, boxplockare, pengar, transportörer
  logistics/         Etikettleverantörer (gränssnitt + nShift/PostNord)
  services/          Kunder, produkter, lager, ordrar, prenumerationer, försändelser, etiketter, auth
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
                  "birthDate": "1988-03-12", "prefStrength": "strong", "prefFlavors": ["mint"] },
    "shippingAddress": { "street": "Sveavägen 10", "postalCode": "111 57", "city": "Stockholm" },
    "lines": [
      { "kind": "mystery_box", "boxSize": 10, "quantity": 1 },
      { "kind": "product", "sku": "ZYN-COOL-MINT-S", "quantity": 2 }
    ],
    "paymentStatus": "paid", "paymentMethod": "klarna", "paymentRef": "KL-99812",
    "ageVerified": true
  }'
```

Kunden skapas om e-posten är ny, annars uppdateras adress och preferenser. `externalRef` skyddar
mot dubbletter. Produktrader reserverar lager direkt; boxinnehåll väljs vid plockning.
Skickas inte `unitPriceOre` används produktens pris respektive boxpriset i `config.ts`.
Frakt beräknas enligt `config.shipping` om `shippingOre` utelämnas.

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
- Styrkeskalan `mild / medium / strong / extra_strong` och att preferenser gäller styrka och smak.
- Endast leverans inom Sverige och 25 % moms på allt.
- Betalning sker i webbshopen (Klarna/Swish/kort); systemet registrerar bara betalstatus och
  återbetalningsbehov, det utför inga betalningar.
- Vilken betalleverantör webbshopen använder avgör hur prenumerationsförnyelsen bäst kopplas
  (webhook eller intern schemaläggning – båda stöds).

## Drift

- Sätt `NODE_ENV=production`, `API_KEY` och `ADMIN_PASSWORD`. Servern vägrar starta i produktion utan API-nyckel.
- Kör bakom en TLS-terminerande proxy; sessionskakan sätts som `Secure` i produktion.
- Databasen är en enda SQLite-fil (`DATABASE_PATH`) i WAL-läge – säkerhetskopiera filen regelbundet.
