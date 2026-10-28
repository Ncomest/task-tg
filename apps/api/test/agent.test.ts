import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessageItem, AgentRunItem, TaskItem } from '@task-tg/shared';
import type { AgentService } from '../src/agent/service.js';
import { buildApp } from '../src/app.js';
import { AuthError } from '../src/auth/telegram.js';

const origin = 'https://agent-test.example';
const token = 'worker-token-for-tests-12345678901234567890';
const user = { id: 'user-1', telegramId: '1', firstName: 'Test', lastName: null, username: null };
const teamId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const runId = '00000000-0000-4000-8000-000000000003';
const leaseToken = 'lease-token-for-tests-12345678901234567890';

const sampleTask = (): TaskItem => ({
  id: taskId, teamId, title: 'Task', description: 'Details', archivedAt: null, completedAt: null, status: 'IN_PROGRESS', project: 'TASK_TG', assigneeId: null,
  creatorId: user.id, version: 2, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
});
const sampleRun = (overrides: Partial<AgentRunItem> = {}): AgentRunItem => ({
  id: runId, taskId, teamId, createdById: user.id, status: 'QUEUED', taskVersion: 2,
  taskTitle: 'Task', taskDescription: 'Details', project: 'TASK_TG', summary: null, branch: null, pullRequestUrl: null,
  error: null, startedAt: null, finishedAt: null, createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z', events: [], ...overrides,
});
const sampleMessage = (overrides: Partial<AgentMessageItem> = {}): AgentMessageItem => ({
  id: '00000000-0000-4000-8000-000000000004', taskId, teamId, runId: null, authorId: user.id,
  role: 'USER', body: 'Уточнение', createdAt: '2026-10-26T00:00:00.000Z', ...overrides,
});

function fakeAgent(calls: string[]) {
  return {
    listRuns: async (task: string, team: string, actor: string) => { calls.push(`list:${task}:${team}:${actor}`); return { runs: [sampleRun()] }; },
    createRun: async (task: string, team: string, actor: string, version: number) => { calls.push(`create:${task}:${team}:${actor}:${version}`); return { run: sampleRun(), task: sampleTask() }; },
    listMessages: async (task: string, team: string, actor: string) => { calls.push(`messages:${task}:${team}:${actor}`); return { messages: [sampleMessage()] }; },
    sendMessage: async (task: string, team: string, actor: string, body: string) => { calls.push(`send:${task}:${team}:${actor}:${body}`); return { message: sampleMessage({ body }), run: sampleRun(), task: sampleTask() }; },
    cancelRun: async (task: string, team: string, actor: string, run: string) => { calls.push(`cancel:${task}:${team}:${actor}:${run}`); return { run: sampleRun({ status: 'CANCELLED' }) }; },
    claim: async (worker: string) => { calls.push(`claim:${worker}`); return null; },
    heartbeat: async (run: string, lease: string) => { calls.push(`heartbeat:${run}:${lease}`); return { status: 'ASSESSING' as const, leaseExpiresAt: '2026-10-26T00:03:00.000Z' }; },
    report: async (run: string, lease: string, stage: string | undefined, message: string) => { calls.push(`report:${run}:${lease}:${stage}:${message}`); return { status: stage ?? 'ASSESSING' }; },
    complete: async (run: string, lease: string, body: { status: string }) => { calls.push(`complete:${run}:${lease}:${body.status}`); return { run: sampleRun({ status: body.status as AgentRunItem['status'] }), task: null }; },
  } as unknown as AgentService;
}

async function fixture(options: { configured?: boolean } = {}) {
  const calls: string[] = [];
  const app = await buildApp({
    checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
    auth: { login: async () => { throw new AuthError(); }, currentUser: async (value) => value === 'alice' ? user : null, logout: async () => {} },
    agent: fakeAgent(calls),
    ...(options.configured === false ? {} : { agentWorkerToken: token }),
  });
  return { app, calls };
}

const userHeaders = { origin, cookie: 'tasktg_dev=alice' };
const workerHeaders = { authorization: `Bearer ${token}` };

test('worker routes require the server token and do not depend on browser Origin', async () => {
  const { app, calls } = await fixture();
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/runs/claim', payload: { workerId: 'w1' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/runs/claim', headers: { authorization: 'Bearer wrong' }, payload: { workerId: 'w1' } })).statusCode, 401);
    const claim = await app.inject({ method: 'POST', url: '/api/agent/runs/claim', headers: workerHeaders, payload: { workerId: 'w1' } });
    assert.equal(claim.statusCode, 204);
    assert.deepEqual(calls, ['claim:w1']);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/runs/claim', headers: { ...workerHeaders, origin: 'https://evil.example' }, payload: { workerId: 'w1' } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/runs/claim', headers: workerHeaders, payload: {} })).statusCode, 400);
    const heartbeat = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/heartbeat`, headers: workerHeaders, payload: { leaseToken } });
    assert.equal(heartbeat.statusCode, 200);
    assert.equal(heartbeat.json().status, 'ASSESSING');
    assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/heartbeat`, payload: { leaseToken } })).statusCode, 401);
    const complete = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/complete`, headers: workerHeaders, payload: { leaseToken, status: 'DONE', summary: 'ok' } });
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.json().run.status, 'DONE');
    assert.ok(calls.some((call) => call.startsWith('heartbeat:')));
    assert.ok(calls.some((call) => call.startsWith('complete:')));
  } finally { await app.close(); }
});

test('agent event reporting is scoped by the run lease and needs no worker token', async () => {
  const { app, calls } = await fixture();
  try {
    const reported = await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/events`, payload: { leaseToken, stage: 'WORKING', message: 'Пишу код' } });
    assert.equal(reported.statusCode, 200);
    assert.equal(reported.json().status, 'WORKING');
    assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${runId}/events`, payload: { leaseToken: 'short', message: 'x' } })).statusCode, 400);
    assert.ok(calls.some((call) => call.startsWith('report:')));
  } finally { await app.close(); }
});

test('team agent routes stay behind cookie auth, Origin checks and task ids', async () => {
  const { app, calls } = await fixture();
  try {
    const base = `/api/teams/${teamId}/tasks/${taskId}/agent-runs`;
    assert.equal((await app.inject({ method: 'POST', url: base, payload: { version: 2 } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: base, headers: { origin }, payload: { version: 2 } })).statusCode, 401);
    const created = await app.inject({ method: 'POST', url: base, headers: userHeaders, payload: { version: 2 } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().run.status, 'QUEUED');
    assert.ok(calls.includes(`create:${taskId}:${teamId}:${user.id}:2`));
    assert.equal((await app.inject({ method: 'POST', url: base, headers: userHeaders, payload: { version: 0 } })).statusCode, 400);
    const list = await app.inject({ method: 'GET', url: base, headers: { cookie: 'tasktg_dev=alice' } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().runs.length, 1);
    const cancelled = await app.inject({ method: 'POST', url: `${base}/${runId}/cancel`, headers: userHeaders, payload: {} });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().run.status, 'CANCELLED');
    assert.ok(calls.includes(`cancel:${taskId}:${teamId}:${user.id}:${runId}`));
  } finally { await app.close(); }
});

test('task chat routes require membership and create a user message with a run', async () => {
  const { app, calls } = await fixture();
  try {
    const base = `/api/teams/${teamId}/tasks/${taskId}/agent-messages`;
    assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: base, payload: { body: 'hello' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: base, headers: { origin }, payload: { body: 'hello' } })).statusCode, 401);
    const list = await app.inject({ method: 'GET', url: base, headers: { cookie: 'tasktg_dev=alice' } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().messages[0].body, 'Уточнение');
    const sent = await app.inject({ method: 'POST', url: base, headers: userHeaders, payload: { body: '  Уточнение  ' } });
    assert.equal(sent.statusCode, 201);
    assert.equal(sent.json().message.body, 'Уточнение');
    assert.equal(sent.json().run.status, 'QUEUED');
    assert.ok(calls.includes(`send:${taskId}:${teamId}:${user.id}:Уточнение`));
    assert.equal((await app.inject({ method: 'POST', url: base, headers: userHeaders, payload: { body: '' } })).statusCode, 400);
  } finally { await app.close(); }
});

test('worker routes report a clear configuration error when the token is absent', async () => {
  const { app } = await fixture({ configured: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/agent/runs/claim', headers: workerHeaders, payload: { workerId: 'w1' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'AGENT_NOT_CONFIGURED');
    const create = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/tasks/${taskId}/agent-runs`, headers: userHeaders, payload: { version: 2 } });
    assert.equal(create.statusCode, 503);
    assert.equal(create.json().error, 'AGENT_NOT_CONFIGURED');
    const message = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/tasks/${taskId}/agent-messages`, headers: userHeaders, payload: { body: 'hello' } });
    assert.equal(message.statusCode, 503);
    assert.equal(message.json().error, 'AGENT_NOT_CONFIGURED');
  } finally { await app.close(); }
});
