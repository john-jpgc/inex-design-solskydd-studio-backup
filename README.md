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
  services/          Kunder, produkter, lager, ordrar, försändelser, personal/auth
  http/api/          JSON-API
  http/admin/        Admin-gränssnitt (server-renderad HTML)
  test/              Tester (node:test)
```

## Kom igång

```bash
npm install
cp .env.example .env        # justera värden
npm run seed                # skapar admin-konto + exempeldata (ej i produktion)
npm run dev                 # http://localhost:3000/admin
```

Standardinloggning efter `npm run seed` (om `ADMIN_EMAIL`/`ADMIN_PASSWORD` inte satts):
`admin@mysterysnus.se` / `admin123` – byt direkt.

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
| `GET` | `/api/v1/shipments` | Lista (`?status=&carrier=&q=`) |
| `GET/PATCH` | `/api/v1/shipments/:id` | Hämta/uppdatera (kollinummer m.m.) |
| `POST` | `/api/v1/shipments/:id/events` | Registrera händelse |
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

## Antaganden att bekräfta

Systemet är byggt utan tillgång till sajten, så några saker är gissningar som är lätta att ändra:

- Boxstorlekar och priser (5/10/20 dosor) samt fraktregler ligger i `src/config.ts`.
- Styrkeskalan `mild / medium / strong / extra_strong` och att preferenser gäller styrka och smak.
- Endast leverans inom Sverige och 25 % moms på allt.
- Betalning sker i webbshopen (Klarna/Swish/kort); systemet registrerar bara betalstatus och
  återbetalningsbehov, det utför inga betalningar.
- Transportörsintegrationen är manuell/webhook-baserad; automatisk etikettutskrift (t.ex. via
  Unifaun/nShift eller PostNords API) är ett naturligt nästa steg.

## Drift

- Sätt `NODE_ENV=production`, `API_KEY` och `ADMIN_PASSWORD`. Servern vägrar starta i produktion utan API-nyckel.
- Kör bakom en TLS-terminerande proxy; sessionskakan sätts som `Secure` i produktion.
- Databasen är en enda SQLite-fil (`DATABASE_PATH`) i WAL-läge – säkerhetskopiera filen regelbundet.
