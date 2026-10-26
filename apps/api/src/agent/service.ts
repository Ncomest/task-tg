import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentEventItem, AgentRunClaim, AgentRunItem, AgentRunStage, AgentRunStatus, TaskItem, TaskStatus } from '@task-tg/shared';
import type { AgentEvent, AgentRun, Prisma, PrismaClient, Task } from '../generated/prisma/client.js';
import { HttpError } from '../errors.js';
import { lockTeam, withTeamMember } from '../teams/access.js';

const LEASE_SECONDS = 180;
const ACTIVE_STATUSES: AgentRunStatus[] = ['QUEUED', 'ASSESSING', 'PLANNED', 'WORKING', 'REVIEW'];
const TERMINAL_STATUSES: AgentRunStatus[] = ['DONE', 'FAILED', 'CANCELLED', 'NEEDS_INPUT'];
const EVENT_STAGES: AgentRunStage[] = ['ASSESSING', 'PLANNED', 'WORKING', 'REVIEW', 'NEEDS_INPUT'];
const STAGE_RANK: Partial<Record<AgentRunStatus, number>> = { ASSESSING: 0, PLANNED: 1, WORKING: 2, REVIEW: 3 };

type AgentRunWithEvents = AgentRun & { events: AgentEvent[] };
type CompleteStatus = Extract<AgentRunStatus, 'DONE' | 'FAILED' | 'NEEDS_INPUT'>;

interface CompleteInput {
  status: CompleteStatus;
  summary?: string | undefined;
  branch?: string | undefined;
  pullRequestUrl?: string | undefined;
  error?: string | undefined;
  taskStatus?: TaskStatus | undefined;
}

const taskItem = (task: Task): TaskItem => ({ ...task, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() });
const eventItem = (event: AgentEvent): AgentEventItem => ({ ...event, createdAt: event.createdAt.toISOString() });
const runItem = (run: AgentRunWithEvents): AgentRunItem => ({
  id: run.id,
  taskId: run.taskId,
  teamId: run.teamId,
  createdById: run.createdById,
  status: run.status,
  taskVersion: run.taskVersion,
  taskTitle: run.taskTitle,
  taskDescription: run.taskDescription,
  summary: run.summary,
  branch: run.branch,
  pullRequestUrl: run.pullRequestUrl,
  error: run.error,
  startedAt: run.startedAt?.toISOString() ?? null,
  finishedAt: run.finishedAt?.toISOString() ?? null,
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
  events: run.events.map(eventItem),
});
const isTerminal = (status: AgentRunStatus) => TERMINAL_STATUSES.includes(status);
const leaseHash = (token: string) => createHash('sha256').update(token).digest('hex');
const sameHash = (stored: string, candidate: string) => {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createAgentService(db: PrismaClient) {
  async function findLeasedRun(tx: Prisma.TransactionClient, runId: string, leaseToken: string) {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || !run.leaseHash || !sameHash(run.leaseHash, leaseHash(leaseToken))) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND');
    if (run.leaseExpiresAt && run.leaseExpiresAt.getTime() < Date.now()) throw new HttpError(409, 'AGENT_LEASE_EXPIRED');
    return run;
  }

  // Team operations (create/cancel) serialize on the Team row. Worker updates
  // lock the same row so a cancel cannot be overwritten by a late heartbeat,
  // report or completion from the agent process.
  async function lockRunTeam(tx: Prisma.TransactionClient, runId: string) {
    const run = await tx.agentRun.findUnique({ where: { id: runId }, select: { teamId: true } });
    if (!run) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND');
    await lockTeam(tx, run.teamId);
  }

  // Expired leases are reaped in their own short transactions. Locking the
  // Team row for each run serializes the reaper with cancel and with worker
  // completion, so a run that finishes or is cancelled concurrently is never
  // overwritten with LEASE_EXPIRED by mistake.
  async function reapExpiredRuns() {
    const now = new Date();
    const expired = await db.agentRun.findMany({
      where: { status: { in: ACTIVE_STATUSES }, leaseExpiresAt: { lt: now } },
      select: { id: true, teamId: true },
      orderBy: [{ teamId: 'asc' }, { id: 'asc' }],
    });
    for (const run of expired) {
      try {
        await db.$transaction(async (tx) => {
          await lockTeam(tx, run.teamId);
          const reaped = await tx.agentRun.updateMany({
            where: { id: run.id, status: { in: ACTIVE_STATUSES }, leaseExpiresAt: { lt: now } },
            data: {
              status: 'FAILED',
              error: 'LEASE_EXPIRED',
              finishedAt: now,
              leaseHash: null,
              leaseExpiresAt: null,
            },
          });
          if (reaped.count) {
            await tx.agentEvent.create({ data: { runId: run.id, stage: 'FAILED', message: 'Агент не вышел на связь. Запуск остановлен.' } });
          }
        }, { maxWait: 5000, timeout: 10000 });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404) continue;
        throw error;
      }
    }
  }

  async function findTask(tx: Prisma.TransactionClient, teamId: string, taskId: string) {
    const task = await tx.task.findFirst({ where: { id: taskId, teamId } });
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND');
    return task;
  }

  return {
    listRuns(taskId: string, teamId: string, userId: string) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        await findTask(tx, teamId, taskId);
        const runs = await tx.agentRun.findMany({
          where: { taskId, teamId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
          include: { events: { orderBy: { createdAt: 'desc' }, take: 50 } },
        });
        return { runs: runs.map((run) => runItem({ ...run, events: [...run.events].reverse() })) };
      });
    },

    createRun(taskId: string, teamId: string, userId: string, version: number) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        const task = await findTask(tx, teamId, taskId);
        if (task.version !== version) throw new HttpError(409, 'VERSION_CONFLICT');
        const active = await tx.agentRun.findFirst({ where: { taskId, status: { in: ACTIVE_STATUSES } }, select: { id: true } });
        if (active) throw new HttpError(409, 'AGENT_RUN_ACTIVE');
        const updatedTask = task.status === 'IN_PROGRESS' ? task : await tx.task.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS', version: { increment: 1 } } });
        const run = await tx.agentRun.create({
          data: {
            taskId,
            teamId,
            createdById: userId,
            taskVersion: updatedTask.version,
            taskTitle: updatedTask.title,
            taskDescription: updatedTask.description,
            events: { create: { stage: 'QUEUED', message: 'Задача поставлена в очередь агенту.' } },
          },
          include: { events: { orderBy: { createdAt: 'asc' } } },
        });
        return { run: runItem(run), task: taskItem(updatedTask) };
      });
    },

    cancelRun(taskId: string, teamId: string, userId: string, runId: string) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        await findTask(tx, teamId, taskId);
        const run = await tx.agentRun.findFirst({ where: { id: runId, taskId, teamId } });
        if (!run) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND');
        if (isTerminal(run.status)) throw new HttpError(409, 'AGENT_RUN_FINISHED');
        const updated = await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'CANCELLED',
            finishedAt: new Date(),
            leaseHash: null,
            leaseExpiresAt: null,
            events: { create: { stage: 'CANCELLED', message: 'Запуск отменён участником команды.' } },
          },
          include: { events: { orderBy: { createdAt: 'asc' } } },
        });
        return { run: runItem(updated) };
      });
    },

    async claim(workerId: string): Promise<AgentRunClaim | null> {
      await reapExpiredRuns();
      return db.$transaction(async (tx) => {
        const now = new Date();
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentRun" WHERE "status" = 'QUEUED'::"AgentRunStatus" ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
        const row = rows[0];
        if (!row) return null;
        const leaseToken = randomBytes(32).toString('base64url');
        const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
        const run = await tx.agentRun.update({
          where: { id: row.id },
          data: {
            status: 'ASSESSING',
            attempts: { increment: 1 },
            workerId,
            leaseHash: leaseHash(leaseToken),
            leaseExpiresAt,
            startedAt: now,
            events: { create: { stage: 'ASSESSING', message: 'Агент взял задачу в работу.' } },
          },
          include: { events: { orderBy: { createdAt: 'asc' } } },
        });
        return { ...runItem(run), leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString() };
      }, { maxWait: 5000, timeout: 10000 });
    },

    async heartbeat(runId: string, leaseToken: string) {
      return db.$transaction(async (tx) => {
        await lockRunTeam(tx, runId);
        const run = await tx.agentRun.findUnique({ where: { id: runId } });
        if (!run) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND');
        if (isTerminal(run.status)) return { status: run.status, leaseExpiresAt: null };
        if (!run.leaseHash || !sameHash(run.leaseHash, leaseHash(leaseToken))) throw new HttpError(404, 'AGENT_RUN_NOT_FOUND');
        if (run.leaseExpiresAt && run.leaseExpiresAt.getTime() < Date.now()) throw new HttpError(409, 'AGENT_LEASE_EXPIRED');
        const leaseExpiresAt = new Date(Date.now() + LEASE_SECONDS * 1000);
        await tx.agentRun.update({ where: { id: run.id }, data: { leaseExpiresAt } });
        return { status: run.status, leaseExpiresAt: leaseExpiresAt.toISOString() };
      }, { maxWait: 5000, timeout: 10000 });
    },

    async report(runId: string, leaseToken: string, stage: AgentRunStage | undefined, message: string) {
      return db.$transaction(async (tx) => {
        await lockRunTeam(tx, runId);
        const run = await findLeasedRun(tx, runId, leaseToken);
        if (isTerminal(run.status)) throw new HttpError(409, 'AGENT_RUN_FINISHED');
        if (stage && !EVENT_STAGES.includes(stage)) throw new HttpError(400, 'INVALID_REQUEST');
        if (stage && stage !== 'NEEDS_INPUT') {
          const current = STAGE_RANK[run.status];
          const next = STAGE_RANK[stage];
          if (current !== undefined && next !== undefined && next < current) throw new HttpError(409, 'AGENT_STAGE_INVALID');
        }
        const now = new Date();
        const terminal = stage === 'NEEDS_INPUT';
        const updated = await tx.agentRun.update({
          where: { id: run.id },
          data: {
            ...(stage ? { status: stage } : {}),
            ...(terminal
              ? { finishedAt: now, leaseHash: null, leaseExpiresAt: null }
              : { leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000) }),
            events: { create: { stage: stage ?? null, message } },
          },
          include: { events: { orderBy: { createdAt: 'asc' } } },
        });
        return { status: updated.status };
      }, { maxWait: 5000, timeout: 10000 });
    },

    async complete(runId: string, leaseToken: string, input: CompleteInput) {
      return db.$transaction(async (tx) => {
        await lockRunTeam(tx, runId);
        const run = await findLeasedRun(tx, runId, leaseToken);
        if (isTerminal(run.status)) throw new HttpError(409, 'AGENT_RUN_FINISHED');
        const now = new Date();
        let changedTask: Task | null = null;
        if (input.taskStatus) {
          const task = await tx.task.findUnique({ where: { id: run.taskId } });
          if (task && task.status !== input.taskStatus) {
            changedTask = await tx.task.update({ where: { id: task.id }, data: { status: input.taskStatus, version: { increment: 1 } } });
          }
        }
        const updated = await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: input.status,
            summary: input.summary ?? null,
            branch: input.branch ?? null,
            pullRequestUrl: input.pullRequestUrl ?? null,
            error: input.error ?? null,
            finishedAt: now,
            leaseHash: null,
            leaseExpiresAt: null,
            events: {
              create: {
                stage: input.status,
                message: input.status === 'DONE'
                  ? 'Агент завершил работу.'
                  : input.status === 'FAILED'
                    ? (input.error ?? 'Запуск завершён с ошибкой.')
                    : (input.summary ?? input.error ?? 'Агенту нужен ответ команды.').slice(0, 1000),
              },
            },
          },
          include: { events: { orderBy: { createdAt: 'asc' } } },
        });
        return { run: runItem(updated), task: changedTask ? taskItem(changedTask) : null };
      }, { maxWait: 5000, timeout: 10000 });
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
export type { CompleteInput };
