import { serve } from '@hono/node-server';
import { config, isProduction } from './config.ts';
import { migrate, openDatabase } from './db/connection.ts';
import { purgeExpiredSessions } from './services/auth.ts';
import { renewDueSubscriptions } from './services/subscriptions.ts';
import { labelProviderStatus } from './services/labels.ts';
import { createApp } from './http/app.ts';
import { DEV_ADMIN_PASSWORD, seedAdmin } from './db/seed.ts';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Node.js ${process.versions.node} är för gammal – systemet kräver Node 22.18 eller nyare (https://nodejs.org).`);
  process.exit(1);
}

if (isProduction() && !config.apiKey) {
  console.error('API_KEY måste vara satt i produktion.');
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const ran = migrate(db);
if (ran.length) console.log(`Körde migrationer: ${ran.join(', ')}`);

// Se till att det alltid går att logga in: skapa admin-kontot om inget finns.
const createdAdmin = seedAdmin(db);
if (createdAdmin) {
  console.log(`Skapade admin-konto: ${createdAdmin} (lösenord: ${process.env.ADMIN_PASSWORD ? 'enligt ADMIN_PASSWORD' : DEV_ADMIN_PASSWORD})`);
}

const app = createApp(db, { log: true });
const sessionTimer = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000);
sessionTimer.unref();

function runRenewals() {
  const result = renewDueSubscriptions(db);
  for (const r of result.created) console.log(`Prenumeration #${r.subscriptionId} förnyad → order ${r.orderNumber}`);
  for (const r of result.failed) console.error(`Prenumeration #${r.subscriptionId} kunde inte förnyas: ${r.error}`);
}
runRenewals();
const renewalTimer = setInterval(runRenewals, config.subscription.renewalIntervalMs);
renewalTimer.unref();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const label = labelProviderStatus();
  console.log(`Mysterysnus OMS lyssnar på http://localhost:${info.port}  (admin: /admin, API: /api/v1)`);
  console.log(`Etiketter: ${label.name}${label.id !== 'manual' && !label.configured ? ' – SAKNAR NYCKLAR, se .env.example' : ''}`);
});
