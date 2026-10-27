import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkService } from '../src/work/service.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

function fixture(member = true) {
  const task = { id: 'task', teamId: 'team', status: 'DONE', version: 1, title: 'Title', description: 'Description', archivedAt: null as Date | null, completedAt: new Date('2026-10-26'), createdAt: new Date(), updatedAt: new Date() };
  let selection: unknown;
  const tx = {
    $queryRaw: async () => [{ id: 'team' }],
    team: { findUniqueOrThrow: async () => ({ id: 'team' }) },
    teamMembership: { findUnique: async () => member ? {} : null },
    task: {
      findFirst: async ({ where }: { where: { id: string; teamId: string } }) => where.id === task.id && where.teamId === task.teamId ? { ...task } : null,
      findMany: async (query: unknown) => { selection = query; return []; },
      update: async ({ data }: { data: { archivedAt: Date | null } }) => { task.archivedAt = data.archivedAt; task.version++; return { ...task }; },
    },
  };
  const db = { $transaction: async (run: (value: typeof tx) => unknown) => run(tx) } as unknown as PrismaClient;
  return { task, service: createWorkService(db), selection: () => selection };
}

test('archive and restore preserve DONE, completion date and task content', async () => {
  const { service, task } = fixture();
  const archived = await service.setArchived('team', 'user', 'task', 1, true);
  assert.ok(archived.archivedAt);
  assert.equal(archived.status, 'DONE');
  const restored = await service.setArchived('team', 'user', 'task', 2, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.status, 'DONE');
  assert.equal(restored.description, 'Description');
  assert.equal(restored.completedAt, task.completedAt.toISOString());
});

test('archive rejects unfinished tasks, stale versions and wrong team resources', async () => {
  const { service, task } = fixture();
  task.status = 'TODO';
  await assert.rejects(service.setArchived('team', 'user', 'task', 1, true), { message: 'TASK_NOT_DONE' });
  task.status = 'DONE';
  await assert.rejects(service.setArchived('team', 'user', 'task', 2, true), { message: 'VERSION_CONFLICT' });
  await assert.rejects(service.setArchived('other-team', 'user', 'task', 1, true), { message: 'TASK_NOT_FOUND' });
  assert.equal(task.archivedAt, null);
});

test('non-members cannot read archive, archive or restore', async () => {
  const { service } = fixture(false);
  await assert.rejects(service.listTasks('team', 'outsider', { archived: true }), { message: 'TEAM_NOT_FOUND' });
  for (const archive of [true, false]) await assert.rejects(service.setArchived('team', 'outsider', 'task', 1, archive), { message: 'TEAM_NOT_FOUND' });
});

test('board excludes archived rows and archive uses team scope and descending archive date', async () => {
  const { service, selection } = fixture();
  await service.listTasks('team', 'user');
  assert.deepEqual((selection() as { where: unknown }).where, { teamId: 'team', archivedAt: null });
  await service.listTasks('team', 'user', { archived: true });
  const query = selection() as { where: unknown; orderBy: unknown };
  assert.deepEqual(query.where, { teamId: 'team', archivedAt: { not: null } });
  assert.deepEqual(query.orderBy, [{ archivedAt: 'desc' }, { id: 'desc' }]);
});
