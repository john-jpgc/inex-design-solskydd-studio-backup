import { Hono } from 'hono';
import type { AppEnv } from './types.ts';
import { idParam } from './validate.ts';
import { recordClick } from '../services/retailers.ts';
import { AppError } from '../domain/errors.ts';

/**
 * Publika spår utan inloggning.
 *
 * /r/:linkId loggar att en kund klickat sig vidare till en återförsäljare och
 * skickar hen dit. Länken byggs av hemsidan med kundens publika token (t) och
 * boxens period (p), så att klicket kan kopplas till rätt profil och månadsbox.
 */
export const publicRoutes = new Hono<AppEnv>().get('/r/:id', (c) => {
  const linkId = idParam(c);
  try {
    const result = recordClick(c.get('db'), linkId, {
      customerToken: c.req.query('t') ?? null,
      period: c.req.query('p') ?? null,
      source: c.req.query('s') ?? 'web',
    });
    return c.redirect(result.redirectUrl, 302);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) {
      return c.text('Länken finns inte längre.', 404);
    }
    throw err;
  }
});
