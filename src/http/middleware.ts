import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { AppError } from '../domain/errors.ts';
import { getSessionUser } from '../services/auth.ts';
import type { AppEnv } from './types.ts';

export const SESSION_COOKIE = 'ms_session';

function apiKeyMatches(provided: string | undefined): boolean {
  if (!config.apiKey || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Läser in eventuell inloggad personal från sessionskakan (utan att kräva den). */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const staff = getSessionUser(c.get('db'), getCookie(c, SESSION_COOKIE));
  if (staff) {
    c.set('staff', staff);
    c.set('actor', staff.name);
  }
  await next();
};

/** API: kräver giltig X-API-Key eller inloggad personal. */
export const requireApiAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (apiKeyMatches(c.req.header('x-api-key'))) {
    if (!c.get('staff')) c.set('actor', 'api');
    return next();
  }
  if (c.get('staff')) return next();
  throw new AppError(401, 'UNAUTHORIZED', 'Ange en giltig X-API-Key eller logga in');
};

/** Admin: kräver inloggad personal, annars omdirigering till inloggningen. */
export const requireStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('staff')) {
    const next_ = encodeURIComponent(c.req.path + (c.req.url.includes('?') ? `?${c.req.url.split('?')[1]}` : ''));
    return c.redirect(`/admin/login?next=${next_}`);
  }
  await next();
};

export const requireRole = (...roles: string[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const staff = c.get('staff');
  if (!staff || !roles.includes(staff.role)) throw new AppError(403, 'FORBIDDEN', 'Du saknar behörighet för detta');
  await next();
};
