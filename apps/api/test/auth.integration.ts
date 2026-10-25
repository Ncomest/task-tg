// Run only against a disposable database explicitly named task_tg_auth_test.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createAuthService, hashSessionToken } from '../src/auth/service.js';
import { createPrismaAuthStore } from '../src/auth/store.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== '/task_tg_auth_test') {
  throw new Error('Integration checks require the disposable task_tg_auth_test database');
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const token = 'test-bot-token-only';
const options = { botToken: token, initDataMaxAgeSeconds: 300, sessionTtlSeconds: 600 };
const auth = createAuthService(createPrismaAuthStore(db), options);
const telegramId = 4503599627370494;

function data(query: string, firstName = 'Integration') {
  const values = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: query, user: JSON.stringify({ id: telegramId, first_name: firstName }) });
  values.sort();
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  values.set('hash', createHmac('sha256', key).update([...values].map(([key, value]) => `${key}=${value}`).join('\n')).digest('hex'));
  return values.toString();
}

try {
  assert.equal(await db.user.count(), 0, 'Integration database must be empty');
  const raw = data('concurrent-login');
  const results = await Promise.allSettled([auth.login(raw), auth.login(raw)]);
  const accepted = results.filter((result) => result.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  assert.equal(await db.user.count(), 1);
  assert.equal(await db.session.count(), 1);
  assert.equal(await db.usedInitData.count(), 1);
  const login = accepted[0];
  assert.ok(login && login.status === 'fulfilled');
  assert.equal((await db.session.findFirstOrThrow()).tokenHash, hashSessionToken(login.value.token));
  // Recreate the service to prove that a session is restored from PostgreSQL.
  const restored = createAuthService(createPrismaAuthStore(db), options);
  assert.equal((await restored.currentUser(login.value.token))?.telegramId, String(telegramId));
  await restored.logout(login.value.token);
  assert.equal(await restored.currentUser(login.value.token), null);
  assert.equal(await db.session.count(), 0);
  const next = await auth.login(data('profile-update', 'Updated'));
  assert.equal(await db.user.count(), 1);
  assert.equal(next.user.firstName, 'Updated');
  await db.session.update({ where: { tokenHash: hashSessionToken(next.token) }, data: { expiresAt: new Date(0) } });
  assert.equal(await auth.currentUser(next.token), null);
  console.log('PASS: concurrent replay is atomic; sessions survive service recreation; logout, expiry and user upsert work in PostgreSQL');
} finally {
  await db.$disconnect();
}

await import('./teams.integration.js');

await import('./tasks.integration.js');

await import('./ideas.integration.js');
