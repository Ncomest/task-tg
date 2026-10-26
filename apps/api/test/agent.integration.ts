import assert from 'node:assert/strict';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createAgentService } from '../src/agent/service.js';
import { createTeamService } from '../src/teams/service.js';
import { createWorkService } from '../src/work/service.js';
import { buildApp } from '../src/app.js';
import { AuthError } from '../src/auth/telegram.js';
import type { AgentRunClaim, AgentRunItem, CurrentUser, TaskItem } from '@task-tg/shared';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== '/task_tg_agent_test') throw new Error('Requires disposable task_tg_agent_test database');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const teams = createTeamService(db);
const work = createWorkService(db);
const agent = createAgentService(db);
const origin = 'https://agent-integration.example';
const workerToken = 'integration-worker-token-12345678901234567890';
const workerHeaders = { authorization: `Bearer ${workerToken}` };
const actors: CurrentUser[] = [];
const tokens = new Map<string, CurrentUser>();
for (let i = 0; i < 3; i++) {
  const user = await db.user.create({ data: { telegramId: BigInt(930000001 + i), firstName: `Agent actor ${i}` } });
  const actor = { id: user.id, telegramId: String(user.telegramId), firstName: user.firstName, lastName: null, username: null };
  actors.push(actor); tokens.set(String(i + 1).repeat(43), actor);
}
const [owner, member, outsider] = actors;
assert.ok(owner && member && outsider);
const app = await buildApp({
  checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
  auth: { login: async () => { throw new AuthError(); }, currentUser: async (token) => tokens.get(token ?? '') ?? null, logout: async () => {} },
  teams, work, agent, agentWorkerToken: workerToken,
});
const request = (actor: CurrentUser, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({
  method, url, headers: { origin, cookie: `tasktg_dev=${[...tokens].find(([, user]) => user.id === actor.id)?.[0]}` }, ...(payload ? { payload } : {}),
});
const worker = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: workerHeaders, ...(payload ? { payload } : {}) });
let teamId = '';
try {
  teamId = (await teams.create(owner.id, { name: 'Agent integration', description: '' })).id;
  await teams.join(member.id, (await teams.createInvite(teamId, owner.id)).token);
  let task = await work.createTask(teamId, owner.id, { title: 'Agent task', description: 'Implement it', status: 'TODO', project: 'TASK_TG', assigneeId: null });
  const base = `/api/teams/${teamId}/tasks/${task.id}/agent-runs`;

  assert.equal((await app.inject(base)).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: base, headers: { origin: 'https://evil.example', cookie: `tasktg_dev=${[...tokens][0]?.[0]}` }, payload: { version: task.version } })).statusCode, 403);
  assert.equal((await request(outsider, 'GET', base)).statusCode, 404);

  const created = await request(member, 'POST', base, { version: task.version });
  assert.equal(created.statusCode, 201);
  const run = created.json().run as AgentRunItem;
  task = created.json().task as TaskItem;
  assert.equal(run.status, 'QUEUED');
  assert.equal(run.project, 'TASK_TG');
  assert.equal(task.status, 'IN_PROGRESS');
  assert.equal(task.project, 'TASK_TG');
  assert.equal(task.version, 2);
  assert.equal((await request(owner, 'POST', base, { version: task.version })).statusCode, 409);
  assert.equal((await request(owner, 'GET', base)).json().runs[0].events[0].message, 'Задача поставлена в очередь агенту.');

  assert.equal((await app.inject({ method: 'POST', url: '/api/agent/runs/claim', payload: { workerId: 'integration-worker' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent/runs/claim', headers: { authorization: 'Bearer wrong' }, payload: { workerId: 'integration-worker' } })).statusCode, 401);
  const claimed = await worker('/api/agent/runs/claim', { workerId: 'integration-worker' });
  assert.equal(claimed.statusCode, 200);
  const claim = claimed.json().run as AgentRunClaim;
  assert.equal(claim.status, 'ASSESSING');
  assert.ok(claim.leaseToken.length >= 20);
  assert.equal((await worker('/api/agent/runs/claim', { workerId: 'integration-worker' })).statusCode, 204);

  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${run.id}/heartbeat`, payload: { leaseToken: 'wrong-lease-token-1234567890' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${run.id}/heartbeat`, headers: workerHeaders, payload: { leaseToken: 'wrong-lease-token-1234567890' } })).statusCode, 404);
  assert.equal((await worker(`/api/agent/runs/${run.id}/heartbeat`, { leaseToken: claim.leaseToken })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${run.id}/events`, payload: { leaseToken: claim.leaseToken, stage: 'PLANNED', message: 'План: изменить API' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${run.id}/events`, payload: { leaseToken: claim.leaseToken, stage: 'WORKING', message: 'Пишу код' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${run.id}/events`, payload: { leaseToken: claim.leaseToken, stage: 'ASSESSING', message: 'Назад' } })).statusCode, 409);
  const listed = (await request(owner, 'GET', base)).json().runs[0] as AgentRunItem;
  assert.equal(listed.status, 'WORKING');
  assert.ok(listed.events.some((event) => event.stage === 'PLANNED'));
  assert.ok(listed.events.some((event) => event.stage === 'WORKING'));

  assert.equal((await worker(`/api/agent/runs/${run.id}/complete`, { leaseToken: claim.leaseToken, status: 'DONE', summary: 'Готово' })).statusCode, 200);
  const completedTask = await work.getTask(teamId, owner.id, task.id);
  assert.equal(completedTask.status, 'IN_PROGRESS');
  assert.equal((await worker(`/api/agent/runs/${run.id}/complete`, { leaseToken: claim.leaseToken, status: 'DONE' })).statusCode, 404);
  assert.equal((await request(owner, 'GET', base)).json().runs[0].status, 'DONE');
  assert.equal((await request(owner, 'POST', `${base}/${run.id}/cancel`, {})).statusCode, 409);

  const second = await request(owner, 'POST', base, { version: completedTask.version });
  assert.equal(second.statusCode, 201);
  const secondRun = second.json().run as AgentRunItem;
  const secondClaimResponse = await worker('/api/agent/runs/claim', { workerId: 'integration-worker' });
  assert.equal(secondClaimResponse.statusCode, 200);
  const secondClaim = secondClaimResponse.json().run as AgentRunClaim;
  assert.equal(secondClaim.id, secondRun.id);
  assert.equal((await request(member, 'POST', `${base}/${secondRun.id}/cancel`, {})).statusCode, 200);
  assert.equal((await request(owner, 'POST', `${base}/${secondRun.id}/cancel`, {})).statusCode, 409);
  assert.equal((await worker(`/api/agent/runs/${secondRun.id}/heartbeat`, { leaseToken: secondClaim.leaseToken })).json().status, 'CANCELLED');
  assert.equal((await worker(`/api/agent/runs/${secondRun.id}/complete`, { leaseToken: secondClaim.leaseToken, status: 'DONE' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/agent/runs/${secondRun.id}/events`, payload: { leaseToken: secondClaim.leaseToken, stage: 'WORKING', message: 'Поздний отчёт' } })).statusCode, 404);

  const thirdTask = await work.getTask(teamId, owner.id, task.id);
  const third = await request(owner, 'POST', base, { version: thirdTask.version });
  assert.equal(third.statusCode, 201);
  const thirdRun = third.json().run as AgentRunItem;
  const thirdClaimResponse = await worker('/api/agent/runs/claim', { workerId: 'integration-worker' });
  assert.equal(thirdClaimResponse.statusCode, 200);
  const thirdClaim = thirdClaimResponse.json().run as AgentRunClaim;
  assert.equal(thirdClaim.id, thirdRun.id);
  await db.agentRun.update({ where: { id: thirdRun.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await worker('/api/agent/runs/claim', { workerId: 'integration-worker' })).statusCode, 204);
  const expired = await db.agentRun.findUniqueOrThrow({ where: { id: thirdRun.id } });
  assert.equal(expired.status, 'FAILED');
  assert.equal(expired.error, 'LEASE_EXPIRED');

  const legacyTask = await db.task.create({ data: { teamId, creatorId: owner.id, title: 'Legacy task without project' } });
  const legacyBase = `/api/teams/${teamId}/tasks/${legacyTask.id}/agent-runs`;
  const legacyRun = await request(owner, 'POST', legacyBase, { version: legacyTask.version });
  assert.equal(legacyRun.statusCode, 409);
  assert.equal(legacyRun.json().error, 'PROJECT_REQUIRED');
  await db.task.delete({ where: { id: legacyTask.id } });

  const beforeDelete = await db.agentRun.count({ where: { taskId: task.id } });
  assert.ok(beforeDelete >= 3);
  const latest = await work.getTask(teamId, owner.id, task.id);
  await work.removeTask(teamId, owner.id, task.id, latest.version);
  assert.equal(await db.agentRun.count({ where: { taskId: task.id } }), 0);
  assert.equal(await db.agentEvent.count({ where: { runId: thirdRun.id } }), 0);

  console.log('PASS: agent run creation, membership isolation, claim lease, heartbeat, stages, completion, cancel, expiry and task cascade');
} finally {
  if (teamId) await db.team.deleteMany({ where: { id: teamId } });
  await db.user.deleteMany({ where: { id: { in: actors.map((actor) => actor.id) } } });
  await app.close(); await db.$disconnect();
}
