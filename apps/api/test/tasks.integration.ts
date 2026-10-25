import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createTeamService } from '../src/teams/service.js';
import { createWorkService } from '../src/work/service.js';
import { buildApp } from '../src/app.js';
import { AuthError } from '../src/auth/telegram.js';
import type { CurrentUser, TaskItem } from '@task-tg/shared';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== '/task_tg_auth_test') throw new Error('Requires disposable task_tg_auth_test database');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const teams = createTeamService(db);
const work = createWorkService(db);
const origin = 'https://work-test.example';
const actors: CurrentUser[] = [];
const tokens = new Map<string, CurrentUser>();
for (let i = 0; i < 4; i++) {
  const user = await db.user.create({ data: { telegramId: BigInt(920000001 + i), firstName: `Task actor ${i}` } });
  const actor = { id: user.id, telegramId: String(user.telegramId), firstName: user.firstName, lastName: null, username: null };
  actors.push(actor); tokens.set(String(i).repeat(43), actor);
}
const [owner, admin, member, outsider] = actors;
assert.ok(owner && admin && member && outsider);
const app = await buildApp({ checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
  auth: { login: async () => { throw new AuthError(); }, currentUser: async token => tokens.get(token ?? '') ?? null, logout: async () => {} }, teams, work });
const request = (actor: CurrentUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: { origin, cookie: `tasktg_dev=${[...tokens].find(([, user]) => user.id === actor.id)?.[0]}` }, ...(payload ? { payload } : {}) });
let teamId = '';
let foreignId = '';
try {
  teamId = (await teams.create(owner.id, { name: 'Task test', description: '' })).id;
  foreignId = (await teams.create(outsider.id, { name: 'Foreign', description: '' })).id;
  for (const actor of [admin, member]) await teams.join(actor.id, (await teams.createInvite(teamId, owner.id)).token);
  await teams.changeRole(teamId, owner.id, admin.id, 'ADMIN');
  const base = `/api/teams/${teamId}/tasks`;
  assert.equal((await app.inject(base)).statusCode, 401);
  assert.equal((await request(owner, 'POST', base, { title: ' ' })).statusCode, 400);
  assert.equal((await request(owner, 'POST', base, { title: 'a', assigneeId: outsider.id })).statusCode, 400);
  assert.equal((await request(owner, 'PATCH', `${base}/${randomUUID()}`, { version: 1 })).statusCode, 400);
  assert.equal((await request(owner, 'GET', `${base}?status=bad`)).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: base, headers: { origin: 'https://evil.example', cookie: 'tasktg_dev=' + '0'.repeat(43) }, payload: { title: 'x' } })).statusCode, 403);
  const created = await request(member, 'POST', base, { title: ' Search target ', description: 'Details', assigneeId: member.id });
  assert.equal(created.statusCode, 201);
  let task = created.json().task as TaskItem;
  assert.equal(task.title, 'Search target');
  for (const actor of [owner, admin, member]) {
    assert.equal((await request(actor, 'GET', `${base}/${task.id}`)).statusCode, 200);
    const changed = await request(actor, 'PATCH', `${base}/${task.id}`, { version: task.version, description: actor.firstName });
    assert.equal(changed.statusCode, 200); task = changed.json().task as TaskItem;
  }
  for (const [method, suffix, body] of [ ['GET', '', undefined], ['GET', `/${task.id}`, undefined], ['POST', '', { title: 'hack' }], ['PATCH', `/${task.id}`, { version: task.version, title: 'hack' }], ['DELETE', `/${task.id}`, { version: task.version }] ] as const) {
    assert.equal((await request(outsider, method, base + suffix, body)).statusCode, 404);
  }
  assert.equal((await request(outsider, 'GET', `/api/teams/${foreignId}/tasks/${task.id}`)).statusCode, 404);
  assert.equal((await request(outsider, 'GET', `/api/teams/${foreignId}/tasks?cursor=${task.id}`)).statusCode, 400);
  assert.equal((await request(outsider, 'PATCH', `/api/teams/${foreignId}/tasks/${task.id}`, { version: task.version, title: 'hack' })).statusCode, 404);
  assert.equal((await request(outsider, 'DELETE', `/api/teams/${foreignId}/tasks/${task.id}`, { version: task.version })).statusCode, 404);
  assert.equal((await request(owner, 'GET', `${base}?q=search&assignee=${member.id}&status=TODO`)).json().tasks.length, 1);
  assert.equal((await request(member, 'GET', `${base}?assignee=me`)).json().tasks.length, 1);
  assert.equal((await request(owner, 'GET', `${base}?assignee=unassigned`)).json().tasks.length, 0);
  const race = await Promise.all([request(owner, 'PATCH', `${base}/${task.id}`, { version: task.version, title: 'Race A' }), request(admin, 'PATCH', `${base}/${task.id}`, { version: task.version, title: 'Race B' })]);
  assert.deepEqual(race.map(result => result.statusCode).sort(), [200, 409]);
  assert.equal(race.find(result => result.statusCode === 409)?.json().error, 'VERSION_CONFLICT');
  assert.equal((await request(owner, 'DELETE', `${base}/${task.id}`, { version: task.version })).statusCode, 409);
  task = (await work.getTask(teamId, owner.id, task.id));
  assert.equal((await request(owner, 'PATCH', `${base}/${task.id}`, { version: task.version, assigneeId: outsider.id })).statusCode, 400);
  await teams.leave(teamId, member.id);
  const unassigned = await work.getTask(teamId, owner.id, task.id);
  assert.equal(unassigned.assigneeId, null); assert.equal(unassigned.version, task.version + 1);
  assert.equal((await request(member, 'GET', base)).statusCode, 404);
  assert.equal((await request(owner, 'PATCH', `${base}/${task.id}`, { version: unassigned.version, assigneeId: member.id })).statusCode, 400);
  const assigned = await work.updateTask(teamId, owner.id, task.id, { version: unassigned.version, assigneeId: admin.id });
  await Promise.allSettled([work.updateTask(teamId, owner.id, task.id, { version: assigned.version, assigneeId: admin.id }), teams.removeMember(teamId, owner.id, admin.id)]);
  task = await work.getTask(teamId, owner.id, task.id);
  assert.equal(task.assigneeId, null);
  assert.equal((await request(admin, 'GET', base)).statusCode, 404);
  await teams.join(member.id, (await teams.createInvite(teamId, owner.id)).token);
  await Promise.allSettled([work.updateTask(teamId, owner.id, task.id, { version: task.version, assigneeId: member.id }), teams.leave(teamId, member.id)]);
  task = await work.getTask(teamId, owner.id, task.id);
  assert.equal(task.assigneeId, null);
  assert.equal(await db.teamMembership.count({ where: { teamId, userId: member.id } }), 0);
  await db.task.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ teamId, creatorId: owner.id, title: `Page ${i}` })) });
  const first = await work.listTasks(teamId, owner.id);
  assert.equal(first.tasks.length, 50); assert.ok(first.nextCursor);
  const second = await work.listTasks(teamId, owner.id, { cursor: first.nextCursor });
  assert.equal(second.tasks.length, 6); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.tasks, ...second.tasks].map(item => item.id)).size, 56);
  assert.equal((await request(owner, 'GET', `/api/teams/${teamId}/ideas`)).statusCode, 200);
  assert.equal((await request(owner, 'DELETE', `${base}/${task.id}`, { version: task.version })).statusCode, 204);
  assert.equal((await request(owner, 'GET', `${base}/${task.id}`)).statusCode, 404);
  // Every member role may delete tasks, including tasks authored by another member.
  for (const role of ['ADMIN', 'MEMBER'] as const) {
    await teams.join(admin.id, (await teams.createInvite(teamId, owner.id)).token);
    if (role === 'ADMIN') await teams.changeRole(teamId, owner.id, admin.id, role);
    const item = await work.createTask(teamId, owner.id, { title: 'Delete policy', description: '', status: 'TODO', assigneeId: null });
    assert.equal((await request(admin, 'DELETE', `${base}/${item.id}`, { version: item.version })).statusCode, 204);
    await teams.leave(teamId, admin.id);
  }
  await teams.remove(teamId, owner.id);
  assert.equal(await db.task.count({ where: { teamId } }), 0);
  console.log('PASS: task API validation, auth/origin, all member roles, team isolation, foreign assignee/cursor, filters, pagination, concurrent versions, stale deletion, leave/removal assignment race and cascade');
} finally {
  if (teamId) await db.team.deleteMany({ where: { id: teamId } });
  if (foreignId) await db.team.deleteMany({ where: { id: foreignId } });
  await db.user.deleteMany({ where: { id: { in: actors.map(actor => actor.id) } } });
  await app.close(); await db.$disconnect();
}

