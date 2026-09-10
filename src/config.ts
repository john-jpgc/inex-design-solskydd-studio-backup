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
  /** Standardpriser (öre, inkl. moms) per boxstorlek när webbshopen inte skickar pris. */
  mysteryBoxPricesOre: {
    5: 19_900,
    10: 34_900,
    20: 64_900,
  } as Record<number, number>,
  /** Lagernivå där en produkt flaggas som "lågt lager" i admin. */
  lowStockThreshold: 10,
};

export function isProduction(): boolean {
  return config.env === 'production';
}
