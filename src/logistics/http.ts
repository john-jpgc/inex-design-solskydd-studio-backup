import { AppError } from '../domain/errors.ts';

/** Liten hjälpare för JSON-anrop mot leverantörers API:er med tydliga fel. */
export async function requestJson<T>(
  url: string,
  init: RequestInit & { providerName: string; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new AppError(502, 'LABEL_PROVIDER_ERROR', `${init.providerName} svarade ${res.status}: ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(502, 'LABEL_PROVIDER_ERROR', `Kunde inte nå ${init.providerName}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
