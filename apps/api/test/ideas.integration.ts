import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createTeamService } from '../src/teams/service.js';
import { createWorkService } from '../src/work/service.js';
import { buildApp } from '../src/app.js';
import { AuthError } from '../src/auth/telegram.js';
import type { CurrentUser, IdeaItem, TaskItem } from '@task-tg/shared';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== '/task_tg_auth_test') throw new Error('Requires disposable task_tg_auth_test database');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const teams = createTeamService(db);
const work = createWorkService(db);
const origin = 'https://idea-test.example';
const actors: CurrentUser[] = [];
const tokens = new Map<string, CurrentUser>();
for (let i = 0; i < 4; i++) {
  const user = await db.user.create({ data: { telegramId: BigInt(930000001 + i), firstName: `Idea actor ${i}` } });
  const actor = { id: user.id, telegramId: String(user.telegramId), firstName: user.firstName, lastName: null, username: null };
  actors.push(actor); tokens.set(String(i).repeat(43), actor);
}
const [owner, admin, member, outsider] = actors;
assert.ok(owner && admin && member && outsider);
const app = await buildApp({ checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
  auth: { login: async () => { throw new AuthError(); }, currentUser: async token => tokens.get(token ?? '') ?? null, logout: async () => {} }, teams, work });
const request = (actor: CurrentUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: { origin, cookie: `tasktg_dev=${[...tokens].find(([, user]) => user.id === actor.id)?.[0]}` }, ...(payload ? { payload } : {}) });
const teamIds: string[] = [];
let failureTrigger = false;
try {
  const teamId = (await teams.create(owner.id, { name: 'Ideas test', description: '' })).id;
  const foreignId = (await teams.create(outsider.id, { name: 'Foreign ideas', description: '' })).id;
  teamIds.push(teamId, foreignId);
  for (const actor of [admin, member]) await teams.join(actor.id, (await teams.createInvite(teamId, owner.id)).token);
  await teams.changeRole(teamId, owner.id, admin.id, 'ADMIN');
  const base = `/api/teams/${teamId}/ideas`;
  const newIdea = (title: string) => work.createIdea(teamId, owner.id, { title, description: `Description of ${title}`, project: 'TG_BUDGET' });
  assert.equal((await app.inject(base)).statusCode, 401);
  for (const payload of [{ title: ' ' }, { title: 'a'.repeat(161) }, { title: 'x', description: 'x'.repeat(5001) }, { title: 'x', taskId: randomUUID() }, { title: 'No project' }, { title: 'Bad project', project: 'UNKNOWN' }]) {
    assert.equal((await request(owner, 'POST', base, payload)).statusCode, 400);
  }
  assert.equal((await request(owner, 'GET', `${base}?cursor=bad`)).statusCode, 400);
  assert.equal((await request(owner, 'POST', `${base}/${randomUUID()}/convert`, { version: 0 })).statusCode, 400);
  assert.equal((await request(owner, 'PATCH', `${base}/${randomUUID()}`, { version: 1 })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: base, headers: { origin: 'https://evil.example', cookie: 'tasktg_dev=' + '0'.repeat(43) }, payload: { title: 'x' } })).statusCode, 403);
  for (const actor of [owner, admin, member]) {
    const created = await request(actor, 'POST', base, { title: ' Role idea ', description: ' Shared text ', project: 'TG_BUDGET' });
    assert.equal(created.statusCode, 201);
    let idea = created.json().idea as IdeaItem;
    assert.equal(idea.title, 'Role idea'); assert.equal(idea.description, 'Shared text');
    assert.equal(idea.project, 'TG_BUDGET');
    assert.equal(idea.creatorId, actor.id);
    assert.equal((await request(actor, 'GET', `${base}/${idea.id}`)).statusCode, 200);
    const changed = await request(actor, 'PATCH', `${base}/${idea.id}`, { version: idea.version, title: 'Updated by role' });
    assert.equal(changed.statusCode, 200); idea = changed.json().idea as IdeaItem;
    assert.equal(idea.description, 'Shared text');
    const converted = await request(actor, 'POST', `${base}/${idea.id}/convert`, { version: idea.version });
    assert.equal(converted.statusCode, 200);
    const task = converted.json().task as TaskItem;
    assert.equal(task.creatorId, actor.id); assert.equal(task.title, idea.title);
    assert.equal(task.description, idea.description); assert.equal(task.status, 'TODO'); assert.equal(task.project, 'TG_BUDGET'); assert.equal(task.assigneeId, null);
    assert.equal((await request(actor, 'PATCH', `${base}/${idea.id}`, { version: converted.json().idea.version, title: 'No edits' })).json().error, 'IDEA_CONVERTED');
    assert.equal((await request(actor, 'DELETE', `${base}/${idea.id}`, { version: converted.json().idea.version })).statusCode, 204);
    assert.ok(await db.task.findUnique({ where: { id: task.id } }));
  }
  const idea = await newIdea('Isolation needle');
  for (const [method, suffix, body] of [ ['GET', '', undefined], ['GET', `/${idea.id}`, undefined], ['POST', '', { title: 'hack', project: 'TG_BUDGET' }], ['PATCH', `/${idea.id}`, { version: 1, title: 'hack' }], ['DELETE', `/${idea.id}`, { version: 1 }], ['POST', `/${idea.id}/convert`, { version: 1 }] ] as const) {
    assert.equal((await request(outsider, method, base + suffix, body)).statusCode, 404);
  }
  for (const [method, suffix, body] of [ ['GET', '', undefined], ['PATCH', '', { version: 1, title: 'hack' }], ['DELETE', '', { version: 1 }], ['POST', '/convert', { version: 1 }] ] as const) {
    assert.equal((await request(outsider, method, `/api/teams/${foreignId}/ideas/${idea.id}${suffix}`, body)).statusCode, 404);
  }
  assert.equal((await request(outsider, 'GET', `/api/teams/${foreignId}/ideas?cursor=${idea.id}`)).json().error, 'INVALID_CURSOR');
  assert.equal((await request(owner, 'GET', `${base}?q=NEEDLE`)).json().ideas.length, 1);
  assert.equal((await request(owner, 'GET', `${base}?q=Description%20of%20Isolation`)).json().ideas.length, 1);
  assert.equal((await request(owner, 'GET', `${base}?q=absent`)).json().ideas.length, 0);
  // One task even for concurrent requests and retries carrying the original version.
  const pair = await Promise.all([request(admin, 'POST', `${base}/${idea.id}/convert`, { version: 1 }), request(member, 'POST', `${base}/${idea.id}/convert`, { version: 1 })]);
  assert.deepEqual(pair.map(result => result.statusCode), [200, 200]);
  assert.equal(pair[0]?.json().task.id, pair[1]?.json().task.id);
  const converted = pair[0]?.json() as { idea: IdeaItem; task: TaskItem };
  assert.equal(converted.idea.version, 2);
  assert.equal((await request(owner, 'POST', `${base}/${idea.id}/convert`, { version: 1 })).json().task.id, converted.task.id);
  assert.equal(await db.task.count({ where: { teamId, title: idea.title } }), 1);
  const patchIdea = await newIdea('Concurrent edits');
  const edits = await Promise.all([request(owner, 'PATCH', `${base}/${patchIdea.id}`, { version: 1, title: 'Edit A' }), request(member, 'PATCH', `${base}/${patchIdea.id}`, { version: 1, title: 'Edit B' })]);
  assert.deepEqual(edits.map(result => result.statusCode).sort(), [200, 409]);
  assert.equal((await request(owner, 'DELETE', `${base}/${patchIdea.id}`, { version: 1 })).json().error, 'VERSION_CONFLICT');
  assert.equal((await request(owner, 'POST', `${base}/${patchIdea.id}/convert`, { version: 1 })).json().error, 'VERSION_CONFLICT');
  // Edit/convert: if edit wins, stale conversion must not silently copy old content.
  const editConvert = await newIdea('Edit convert race');
  const mixed = await Promise.all([request(member, 'PATCH', `${base}/${editConvert.id}`, { version: 1, title: 'Edited first', description: 'New content' }), request(admin, 'POST', `${base}/${editConvert.id}/convert`, { version: 1 })]);
  const mixedIdea = await work.getIdea(teamId, owner.id, editConvert.id);
  if (mixed[0]?.statusCode === 200) {
    assert.equal(mixed[1]?.statusCode, 409); assert.equal(mixedIdea.convertedAt, null);
    const result = await work.convertIdea(teamId, owner.id, mixedIdea.id, mixedIdea.version);
    assert.equal(result.task.title, 'Edited first'); assert.equal(result.task.description, 'New content');
  } else {
    assert.equal(mixed[0]?.json().error, 'IDEA_CONVERTED'); assert.equal(mixed[1]?.statusCode, 200);
    assert.equal(mixed[1]?.json().task.title, editConvert.title);
  }
  const deleteConvert = await newIdea('Delete convert race');
  const removed = await Promise.all([request(owner, 'DELETE', `${base}/${deleteConvert.id}`, { version: 1 }), request(member, 'POST', `${base}/${deleteConvert.id}/convert`, { version: 1 })]);
  if (removed[0]?.statusCode === 204) {
    assert.equal(removed[1]?.statusCode, 404);
    assert.equal(await db.task.count({ where: { teamId, title: deleteConvert.title } }), 0);
  } else {
    assert.equal(removed[0]?.statusCode, 409); assert.equal(removed[1]?.statusCode, 200);
  }
  const editDelete = await newIdea('Edit delete race');
  const deletion = await Promise.all([request(member, 'PATCH', `${base}/${editDelete.id}`, { version: 1, title: 'Keep edit' }), request(admin, 'DELETE', `${base}/${editDelete.id}`, { version: 1 })]);
  assert.ok((deletion[0]?.statusCode === 200 && deletion[1]?.statusCode === 409) || (deletion[0]?.statusCode === 404 && deletion[1]?.statusCode === 204));
  // Removing the linked task must never make conversion create a replacement.
  const taskRemoval = await Promise.allSettled([work.removeTask(teamId, owner.id, converted.task.id, converted.task.version), work.convertIdea(teamId, admin.id, idea.id, 1)]);
  assert.equal(taskRemoval[0]?.status, 'fulfilled');
  const afterTaskRemoval = await work.getIdea(teamId, owner.id, idea.id);
  assert.equal(afterTaskRemoval.taskId, null); assert.ok(afterTaskRemoval.convertedAt);
  assert.equal((await request(owner, 'POST', `${base}/${idea.id}/convert`, { version: afterTaskRemoval.version })).json().error, 'CONVERTED_TASK_DELETED');
  assert.equal(await db.task.count({ where: { teamId, title: idea.title } }), 0);
  // Force an error on the second write to prove rollback of the first write.
  await db.$executeRawUnsafe(`CREATE FUNCTION stage5_fail_conversion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'Rollback sentinel' AND NEW."taskId" IS NOT NULL THEN RAISE EXCEPTION 'intentional integration failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER stage5_conversion_failure BEFORE UPDATE ON "Idea" FOR EACH ROW EXECUTE FUNCTION stage5_fail_conversion()');
  failureTrigger = true;
  const rollback = await newIdea('Rollback sentinel');
  assert.equal((await request(owner, 'POST', `${base}/${rollback.id}/convert`, { version: 1 })).statusCode, 500);
  assert.equal(await db.task.count({ where: { teamId, title: rollback.title } }), 0);
  const unchanged = await work.getIdea(teamId, owner.id, rollback.id);
  assert.equal(unchanged.version, 1); assert.equal(unchanged.convertedAt, null); assert.equal(unchanged.taskId, null);
  await db.$executeRawUnsafe('DROP TRIGGER stage5_conversion_failure ON "Idea"');
  await db.$executeRawUnsafe('DROP FUNCTION stage5_fail_conversion()'); failureTrigger = false;
  const afterRollback = await work.convertIdea(teamId, member.id, rollback.id, 1);
  assert.equal(afterRollback.idea.taskId, afterRollback.task.id);
  // Membership and conversion use the same team lock.
  const departure = await newIdea('Departure race');
  const leave = await Promise.allSettled([work.convertIdea(teamId, member.id, departure.id, 1), teams.leave(teamId, member.id)]);
  assert.equal(leave[1]?.status, 'fulfilled');
  assert.equal((await request(member, 'GET', base)).statusCode, 404);
  assert.equal((await request(member, 'POST', `${base}/${departure.id}/convert`, { version: 1 })).statusCode, 404);
  assert.equal(await db.task.count({ where: { teamId, title: departure.title } }), leave[0]?.status === 'fulfilled' ? 1 : 0);
  await db.idea.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ teamId, creatorId: owner.id, title: `Page idea ${i}` })) });
  const first = await work.listIdeas(teamId, owner.id, { q: 'Page idea' });
  assert.equal(first.ideas.length, 50); assert.ok(first.nextCursor);
  const second = await work.listIdeas(teamId, owner.id, { q: 'Page idea', cursor: first.nextCursor });
  assert.equal(second.ideas.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.ideas, ...second.ideas].map(item => item.id)).size, 55);
  const cursorIdea = first.ideas[49]; assert.ok(cursorIdea);
  await work.removeIdea(teamId, owner.id, cursorIdea.id, cursorIdea.version);
  assert.equal((await request(owner, 'GET', `${base}?cursor=${cursorIdea.id}`)).json().error, 'INVALID_CURSOR');
  // Deletion races with conversion, then cascades both tables.
  const cascade = await teams.create(owner.id, { name: 'Cascade race', description: '' }); teamIds.push(cascade.id);
  const cascadedIdea = await work.createIdea(cascade.id, owner.id, { title: 'Cascade', description: '', project: 'TASK_TG' });
  const cascadeRace = await Promise.allSettled([work.convertIdea(cascade.id, owner.id, cascadedIdea.id, 1), teams.remove(cascade.id, owner.id)]);
  assert.equal(cascadeRace[1]?.status, 'fulfilled');
  assert.equal(await db.idea.count({ where: { teamId: cascade.id } }), 0);
  assert.equal(await db.task.count({ where: { teamId: cascade.id } }), 0);
  await teams.remove(teamId, owner.id);
  assert.equal(await db.idea.count({ where: { teamId } }), 0);
  assert.equal(await db.task.count({ where: { teamId } }), 0);
  console.log('PASS: ideas API validation, roles, isolation, search/pagination, version conflicts, concurrent/repeated conversion, edit/delete/convert races, linked-task deletion, transaction rollback, membership race and team cascades');
} finally {
  if (failureTrigger) {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS stage5_conversion_failure ON "Idea"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS stage5_fail_conversion()');
  }
  await db.team.deleteMany({ where: { id: { in: teamIds } } });
  await db.user.deleteMany({ where: { id: { in: actors.map(actor => actor.id) } } });
  await app.close(); await db.$disconnect();
}
