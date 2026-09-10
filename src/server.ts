import { serve } from '@hono/node-server';
import { config, isProduction } from './config.ts';
import { migrate, openDatabase } from './db/connection.ts';
import { purgeExpiredSessions } from './services/auth.ts';
import { createApp } from './http/app.ts';

if (isProduction() && !config.apiKey) {
  console.error('API_KEY måste vara satt i produktion.');
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const ran = migrate(db);
if (ran.length) console.log(`Körde migrationer: ${ran.join(', ')}`);

const app = createApp(db, { log: true });
const timer = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000);
timer.unref();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Mysterysnus OMS lyssnar på http://localhost:${info.port}  (admin: /admin, API: /api/v1)`);
});
