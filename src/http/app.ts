import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { Db } from '../db/connection.ts';
import { AppError } from '../domain/errors.ts';
import type { AppEnv } from './types.ts';
import { loadSession } from './middleware.ts';
import { api } from './api/index.ts';
import { admin } from './admin/routes.ts';
import { errorPage } from './admin/views.ts';

export function createApp(db: Db, opts: { log?: boolean } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  if (opts.log) app.use('*', logger());
  app.use('*', secureHeaders());
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('actor', 'system');
    await next();
  });
  app.use('*', loadSession);

  app.get('/', (c) => c.redirect('/admin'));
  app.route('/api/v1', api);
  app.route('/admin', admin);

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'NOT_FOUND', message: 'Sidan finns inte' } }, 404);
    return c.html(errorPage(c.get('staff'), 404, 'Sidan finns inte'), 404);
  });

  app.onError((err, c) => {
    const isApi = c.req.path.startsWith('/api/');
    if (err instanceof AppError) {
      if (isApi) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? undefined } }, err.status as 400);
      return c.html(errorPage(c.get('staff'), err.status, err.message), err.status as 400);
    }
    console.error(err);
    if (isApi) return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Ett oväntat fel inträffade' } }, 500);
    return c.html(errorPage(c.get('staff'), 500, 'Ett oväntat fel inträffade'), 500);
  });

  return app;
}
