import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';

test('liveness works independently of database readiness; closing releases resources', async () => {
  let closed = false;
  const app = await buildApp({ checkDatabase: async () => { throw new Error('private connection details'); }, closeDatabase: async () => { closed = true; }, logLevel: 'silent' });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    const response = await app.inject('/api/ready');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'unavailable', database: 'unavailable' });
    assert.equal(response.body.includes('private connection details'), false);
  } finally { await app.close(); }
  assert.equal(closed, true);
});

test('readiness reports successful database probe', async () => {
  const app = await buildApp({ checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent' });
  try {
    const response = await app.inject('/api/ready');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', database: 'connected' });
  } finally { await app.close(); }
});
