import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';

const origin = 'https://production.example:8443';
const user = (id: string) => ({ id, telegramId: id, firstName: 'Test', lastName: null, username: null });

test('authenticated rate limits separate users behind one proxy and ignore spoofed forwarding', async () => {
  const app = await buildApp({
    checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
    auth: { login: async () => { throw new Error('unused'); }, currentUser: async token => token ? user(token) : null, logout: async () => {} },
  });
  try {
    for (let i = 0; i < 120; i++) {
      assert.equal((await app.inject({ url: '/api/me', headers: { cookie: 'tasktg_dev=alice' } })).statusCode, 200);
    }
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: 'tasktg_dev=alice', 'x-forwarded-for': '198.51.100.7' } })).statusCode, 429);
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: 'tasktg_dev=bob' } })).statusCode, 200);
    assert.equal((await app.inject('/api/ready')).statusCode, 200);
  } finally { await app.close(); }
});

test('write protection covers all methods and errors never reflect private data', async () => {
  const app = await buildApp({
    checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
    auth: { login: async () => { throw new Error('unused'); }, currentUser: async token => token ? user(token) : null, logout: async () => {} },
  });
  const marker = 'private-error-marker';
  app.patch('/api/protected-write', async () => { throw new Error(marker); });
  app.delete('/api/protected-write', async () => ({ ok: true }));
  try {
    for (const method of ['PATCH', 'DELETE'] as const) {
      for (const headers of [{ cookie: 'tasktg_dev=alice' }, { cookie: 'tasktg_dev=alice', origin: 'https://attacker.example' }, { cookie: 'tasktg_dev=alice', origin: 'null' }]) {
        assert.equal((await app.inject({ method, url: '/api/protected-write', headers })).statusCode, 403);
      }
    }
    const response = await app.inject({ method: 'PATCH', url: '/api/protected-write', headers: { origin, cookie: 'tasktg_dev=alice' } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'INTERNAL_ERROR' });
    assert.equal(response.body.includes(marker), false);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/protected-write', headers: { origin, cookie: 'tasktg_dev=alice' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/me', headers: { origin: 'https://attacker.example' } })).statusCode, 401);
  } finally { await app.close(); }
});
