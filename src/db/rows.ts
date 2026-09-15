/** Hjälpfunktioner för att mappa SQLite-rader (snake_case) till objekt (camelCase). */

type Row = Record<string, unknown>;

export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function toCamel<T>(row: Row | undefined, opts: { json?: string[]; bool?: string[] } = {}): T | undefined {
  if (!row) return undefined;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  for (const key of opts.json ?? []) {
    const raw = out[key];
    out[key] = typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
  }
  for (const key of opts.bool ?? []) out[key] = Boolean(out[key]);
  return out as T;
}

export function toCamelAll<T>(rows: Row[], opts?: { json?: string[]; bool?: string[] }): T[] {
  return rows.map((r) => toCamel<T>(r, opts) as T);
}
