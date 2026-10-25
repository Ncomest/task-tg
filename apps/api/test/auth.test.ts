import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { createAuthService, hashSessionToken, type AuthStore, type NewSession, type SessionRecord } from '../src/auth/service.js';
import { validateInitData } from '../src/auth/telegram.js';

const botToken = '123456:fake-token-used-only-in-tests';
const now = new Date('2026-10-23T00:00:00Z');
const origin = 'https://test.example:8443';

function signedData(overrides: Record<string, string> = {}) {
  const parameters = new URLSearchParams({
    auth_date: String(now.getTime() / 1000),
    query_id: 'test-query',
    user: JSON.stringify({ id: 4503599627370495, first_name: 'Тест', username: 'test_user' }),
    signature: 'opaque-ed25519-value-included-in-hmac',
    ...overrides,
  });
  const data = [...parameters].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  parameters.set('hash', createHmac('sha256', key).update(data).digest('hex'));
  return parameters.toString();
}

function memoryStore() {
  const sessions = new Map<string, SessionRecord>();
  const used = new Set<string>();
  const writes: NewSession[] = [];
  const store: AuthStore = {
    async createSession(input) {
      if (used.has(input.grantHash)) return null;
      used.add(input.grantHash);
      writes.push(input);
      const user = { id: 'user-id', telegramId: String(input.user.id), firstName: input.user.first_name, lastName: input.user.last_name ?? null, username: input.user.username ?? null };
      sessions.set(input.tokenHash, { user, expiresAt: input.expiresAt });
      return user;
    },
    async findSession(hash) { return sessions.get(hash) ?? null; },
    async deleteSession(hash) { sessions.delete(hash); },
  };
  return { store, sessions, writes };
}

async function fixture() {
  const memory = memoryStore();
  let date = now;
  const service = createAuthService(memory.store, { botToken, initDataMaxAgeSeconds: 300, sessionTtlSeconds: 120, now: () => date });
  const app = await buildApp({ checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', auth: service, appOrigin: origin, secureCookies: true, sessionTtlSeconds: 120 });
  const login = (initData = signedData()) => app.inject({ method: 'POST', url: '/api/auth/telegram', headers: { origin }, payload: { initData } });
  return { ...memory, app, login, advanceTime: () => { date = new Date(now.getTime() + 121000); } };
}

test('HMAC rejects tampering, duplicate fields, malformed user, stale and future data', () => {
  assert.equal(validateInitData(signedData(), botToken, now, 300).user.id, 4503599627370495);
  const modified = new URLSearchParams(signedData());
  modified.set('user', JSON.stringify({ id: 7, first_name: 'Attacker' }));
  const cases = [
    modified.toString(), `${signedData()}&auth_date=1`, `${signedData()}&hash=abcd`,
    signedData({ auth_date: String(now.getTime() / 1000 - 300) }),
    signedData({ auth_date: String(now.getTime() / 1000 + 31) }),
    signedData({ user: '{invalid json' }), signedData({ user: '{"id":1}' }),
    signedData({ user: '{"id":-1,"first_name":"bad"}' }),
  ];
  for (const raw of cases) assert.throws(() => validateInitData(raw, botToken, now, 300));
  assert.throws(() => validateInitData(signedData(), 'wrong-token', now, 300));
});

test('session is opaque, hashed in storage, protected in cookie and revoked on logout', async () => {
  const { app, login, writes } = await fixture();
  try {
    assert.equal((await app.inject('/api/me')).statusCode, 401);
    const response = await login();
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies[0];
    assert.ok(cookie);
    assert.equal(cookie.name, '__Host-tasktg');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, 'None');
    assert.equal(cookie.partitioned, true);
    assert.equal(cookie.domain, undefined);
    assert.equal(writes[0]?.tokenHash, hashSessionToken(cookie.value));
    assert.notEqual(writes[0]?.tokenHash, cookie.value);
    assert.equal(response.body.includes(cookie.value), false);
    const headers = { cookie: `${cookie.name}=${cookie.value}` };
    const me = await app.inject({ url: '/api/me', headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.telegramId, '4503599627370495');
    assert.equal(me.headers['cache-control'], 'no-store');
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin } });
    assert.equal(logout.statusCode, 204);
    assert.equal((await app.inject({ url: '/api/me', headers })).statusCode, 401);
  } finally { await app.close(); }
});

test('expired and malformed sessions are rejected; routes are protected by default', async () => {
  const { app, login, advanceTime } = await fixture();
  app.get('/api/future-protected-route', async () => ({ secret: true }));
  try {
    assert.equal((await app.inject('/api/future-protected-route')).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: '__Host-tasktg=invalid' } })).statusCode, 401);
    const response = await login();
    const cookie = response.cookies[0];
    assert.ok(cookie);
    advanceTime();
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: `${cookie.name}=${cookie.value}` } })).statusCode, 401);
  } finally { await app.close(); }
});

test('login grants are single use including simultaneous requests', async () => {
  const { app, login, writes } = await fixture();
  try {
    const responses = await Promise.all([login(), login()]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 401]);
    assert.equal(writes.length, 1);
    assert.equal((await login()).json().error, 'INIT_DATA_ALREADY_USED');
  } finally { await app.close(); }
});

test('cross-origin and missing-origin writes cannot create or revoke sessions', async () => {
  const { app, writes } = await fixture();
  try {
    for (const headers of [{ origin: 'https://attacker.example' }, {}]) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers, payload: { initData: signedData() } });
      assert.equal(response.statusCode, 403);
      const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
      assert.equal(logout.statusCode, 403);
    }
    assert.equal(writes.length, 0);
    const invalid = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers: { origin }, payload: { initData: 'bad' } });
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.headers['set-cookie'], undefined);
  } finally { await app.close(); }
});

test('login requests have a bounded rate and reject invalid request bodies', async () => {
  const { app } = await fixture();
  try {
    const body = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers: { origin }, payload: {} });
    assert.equal(body.statusCode, 400);
    let last;
    for (let index = 0; index < 21; index++) {
      last = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers: { origin }, payload: { initData: 'bad' } });
    }
    assert.equal(last?.statusCode, 429);
  } finally { await app.close(); }
});
