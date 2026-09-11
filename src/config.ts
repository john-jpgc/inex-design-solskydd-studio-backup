const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 3000),
  dbPath: env.DATABASE_PATH ?? './data/mysterysnus.db',
  /** API-nyckel för webbshop/integrationer (header X-API-Key). Tom = endast inloggad personal. */
  apiKey: env.API_KEY ?? '',
  sessionTtlHours: 12,
  currency: 'SEK',
  /** Lägsta ålder för köp av snus/nikotinprodukter i Sverige. */
  minAge: 18,
  /** Standardmoms för snus och nikotinportioner (procent). */
  vatRate: 25,
  shipping: {
    /** Fri frakt vid ordervärde (öre) från och med detta belopp. */
    freeThresholdOre: 49_900,
    standardOre: 4_900,
  },
  /** Antal dosor i en standardbox (skickas en gång i månaden). */
  defaultBoxSize: 4,
  /**
   * Standardpriser (öre, inkl. moms) per boxstorlek när webbshopen inte skickar pris.
   * OBS: 249 kr är ett platshållarpris – sätt det verkliga priset här.
   */
  mysteryBoxPricesOre: {
    4: 24_900,
  } as Record<number, number>,
  subscription: {
    /** Hur ofta förnyelser körs automatiskt i servern (ms). */
    renewalIntervalMs: 60 * 60 * 1000,
  },
  /** Etikettleverantör: "manual" (kollinummer skrivs in för hand), "nshift" eller "postnord". */
  labelProvider: env.LABEL_PROVIDER ?? 'manual',
  /** Avsändaradress som skrivs på fraktetiketter. */
  sender: {
    name: env.SENDER_NAME ?? 'Mysterysnus',
    street: env.SENDER_STREET ?? '',
    postalCode: env.SENDER_POSTAL_CODE ?? '',
    city: env.SENDER_CITY ?? '',
    country: env.SENDER_COUNTRY ?? 'SE',
    phone: env.SENDER_PHONE ?? '',
    email: env.SENDER_EMAIL ?? '',
  },
  nshift: {
    baseUrl: env.NSHIFT_BASE_URL ?? 'https://api.unifaun.com/rs-extapi/v1',
    apiId: env.NSHIFT_API_ID ?? '',
    apiSecret: env.NSHIFT_API_SECRET ?? '',
    /** Avsändar-id ("sender quick id") i nShift/Unifaun. */
    senderId: env.NSHIFT_SENDER_ID ?? '',
  },
  postnord: {
    baseUrl: env.POSTNORD_BASE_URL ?? 'https://api2.postnord.com',
    apiKey: env.POSTNORD_API_KEY ?? '',
    /** PostNord-kundnummer som fraktavtalet är knutet till. */
    customerNumber: env.POSTNORD_CUSTOMER_NUMBER ?? '',
  },
  /** Lagernivå där en produkt flaggas som "lågt lager" i admin. */
  lowStockThreshold: 10,
};

export function isProduction(): boolean {
  return config.env === 'production';
}
