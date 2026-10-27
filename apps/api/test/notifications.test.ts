import assert from 'node:assert/strict';
import test from 'node:test';
import type { CurrentUser, IdeaItem, TaskItem } from '@task-tg/shared';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { WorkService } from '../src/work/service.js';
import { buildApp } from '../src/app.js';
import { AuthError } from '../src/auth/telegram.js';
import { createTaskNotifier, formatNewTaskMessage, type NewTaskNotification } from '../src/notifications/tasks.js';
import { createTelegramSender } from '../src/notifications/telegram.js';

const origin = 'https://notifications-test.example';
const teamId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const ideaId = '00000000-0000-4000-8000-000000000003';
const user: CurrentUser = { id: 'author', telegramId: '1', firstName: 'Anna', lastName: null, username: null };
const task: TaskItem = {
  id: taskId, teamId, title: 'Ship notifications', description: 'Details', archivedAt: null, completedAt: null, status: 'TODO', project: 'TASK_TG', assigneeId: null,
  creatorId: user.id, version: 1, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
};
const idea: IdeaItem = {
  id: ideaId, teamId, title: 'Idea', description: '', project: 'TASK_TG', creatorId: user.id, taskId: null, convertedAt: null,
  version: 1, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
};

test('new task message contains team, author, assignee and a bounded description', () => {
  const message = formatNewTaskMessage({
    teamName: 'Team', title: 'Ship notifications', description: 'x'.repeat(500), project: 'TG_BUDGET',
    authorName: 'Anna', assigneeName: 'Boris',
  });
  assert.match(message, /Новая задача в команде «Team»/);
  assert.match(message, /Ship notifications/);
  assert.match(message, /Проект: tg-budget/);
  assert.match(message, /Автор: Anna/);
  assert.match(message, /Ответственный: Boris/);
  assert.ok(message.length < 4096);
  assert.equal(message.includes('x'.repeat(401)), false);
  assert.equal(formatNewTaskMessage({ teamName: 'Team', title: 'Task', description: '', project: null, authorName: 'Anna', assigneeName: null }).includes('Ответственный'), false);
});

test('task notifier excludes the author and tolerates unreachable recipients', async () => {
  const sent: string[] = [];
  const db = {
    team: {
      findUnique: async () => ({
        name: 'Team',
        memberships: [
          { userId: 'author', user: { firstName: 'Anna', lastName: null, username: null, telegramId: BigInt(1) } },
          { userId: 'bob', user: { firstName: 'Bob', lastName: null, username: 'bob', telegramId: BigInt(2) } },
          { userId: 'carol', user: { firstName: 'Carol', lastName: null, username: null, telegramId: BigInt(3) } },
        ],
      }),
    },
  } as unknown as PrismaClient;
  const notifier = createTaskNotifier(db, {
    sendMessage: async (chatId) => {
      sent.push(chatId);
      if (chatId === '3') throw new Error('bot blocked');
    },
  });
  const result = await notifier.taskCreated({ teamId, actorId: user.id, task });
  assert.deepEqual(sent.sort(), ['2', '3']);
  assert.deepEqual(result, { sent: 1, failed: 1 });
});

test('telegram sender posts the chat id and never exposes the bot token in errors', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const sender = createTelegramSender({
    botToken: '123:secret-token-value',
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await sender.sendMessage('42', 'hello');
  assert.equal(requests[0]?.url, 'https://api.telegram.org/bot123:secret-token-value/sendMessage');
  assert.equal(requests[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), { chat_id: '42', text: 'hello', disable_web_page_preview: true });
  const failing = createTelegramSender({
    botToken: '123:secret-token-value',
    fetch: async () => new Response('forbidden', { status: 403 }),
  });
  await assert.rejects(() => failing.sendMessage('42', 'hello'), (error: unknown) => error instanceof Error && !error.message.includes('secret-token-value'));
});

test('task creation stays successful when notifications fail or are not configured', async () => {
  const notified: NewTaskNotification[] = [];
  let fail = false;
  let convertCreated = true;
  const work = {
    createTask: async () => task,
    convertIdea: async () => ({ idea, task, created: convertCreated }),
  } as unknown as WorkService;
  const app = await buildApp({
    checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
    auth: { login: async () => { throw new AuthError(); }, currentUser: async (value) => value === 'alice' ? user : null, logout: async () => {} },
    work,
    taskNotifier: {
      taskCreated: async (input) => {
        notified.push(input);
        if (fail) throw new Error('telegram down');
        return { sent: 1, failed: 0 };
      },
    },
  });
  const headers = { origin, cookie: 'tasktg_dev=alice' };
  try {
    const created = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/tasks`, headers, payload: { title: 'New task', project: 'TG_BUDGET' } });
    assert.equal(created.statusCode, 201);
    assert.equal(notified.length, 1);
    assert.equal(notified[0]?.actorId, user.id);
    assert.equal(notified[0]?.task.id, taskId);

    fail = true;
    assert.equal((await app.inject({ method: 'POST', url: `/api/teams/${teamId}/tasks`, headers, payload: { title: 'Still created', project: 'TG_BUDGET' } })).statusCode, 201);

    fail = false;
    assert.equal((await app.inject({ method: 'POST', url: `/api/teams/${teamId}/ideas/${ideaId}/convert`, headers, payload: { version: 1 } })).statusCode, 200);
    assert.equal(notified.length, 3);
    convertCreated = false;
    assert.equal((await app.inject({ method: 'POST', url: `/api/teams/${teamId}/ideas/${ideaId}/convert`, headers, payload: { version: 1 } })).statusCode, 200);
    assert.equal(notified.length, 3);
  } finally { await app.close(); }
});
