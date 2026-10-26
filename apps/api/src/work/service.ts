import type { IdeaItem, TaskItem, TaskStatus } from '@task-tg/shared';
import type { PrismaClient, Prisma, Task, Idea } from '../generated/prisma/client.js';
import { withTeamMember } from '../teams/access.js';
import { HttpError } from '../errors.js';

interface TaskInput { title: string; description: string; status: TaskStatus; assigneeId: string | null }
interface TaskChanges { version: number; title?: string | undefined; description?: string | undefined; status?: TaskStatus | undefined; assigneeId?: string | null | undefined }
interface IdeaInput { title: string; description: string }
interface IdeaChanges { version: number; title?: string | undefined; description?: string | undefined }
interface Filters { q?: string | undefined; status?: TaskStatus | undefined; assignee?: string | undefined; cursor?: string | undefined }
const taskItem = (task: Task): TaskItem => ({ ...task, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() });
const ideaItem = (idea: Idea): IdeaItem => ({ ...idea, convertedAt: idea.convertedAt?.toISOString() ?? null, createdAt: idea.createdAt.toISOString(), updatedAt: idea.updatedAt.toISOString() });
const conflict = () => new HttpError(409, 'VERSION_CONFLICT');

export function createWorkService(db: PrismaClient) {
  async function assignee(tx: Prisma.TransactionClient, teamId: string, userId: string | null | undefined) {
    if (userId && !await tx.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } } })) throw new HttpError(400, 'ASSIGNEE_NOT_MEMBER');
  }
  async function findTask(tx: Prisma.TransactionClient, teamId: string, id: string) {
    const task = await tx.task.findFirst({ where: { id, teamId } });
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND');
    return task;
  }
  async function findIdea(tx: Prisma.TransactionClient, teamId: string, id: string) {
    const idea = await tx.idea.findFirst({ where: { id, teamId } });
    if (!idea) throw new HttpError(404, 'IDEA_NOT_FOUND');
    return idea;
  }
  return {
    listTasks(teamId: string, userId: string, filters: Filters = {}) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        if (filters.cursor && !await tx.task.findFirst({ where: { id: filters.cursor, teamId } })) throw new HttpError(400, 'INVALID_CURSOR');
        const rows = await tx.task.findMany({
          where: { teamId, ...(filters.status ? { status: filters.status } : {}), ...(filters.assignee ? { assigneeId: filters.assignee === 'unassigned' ? null : filters.assignee === 'me' ? userId : filters.assignee } : {}), ...(filters.q ? { OR: [{ title: { contains: filters.q, mode: 'insensitive' } }, { description: { contains: filters.q, mode: 'insensitive' } }] } : {}) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
          ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
        });
        return { tasks: rows.slice(0, 50).map(taskItem), nextCursor: rows.length > 50 ? rows[49]?.id ?? null : null };
      });
    },
    createTask(teamId: string, userId: string, input: TaskInput) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        await assignee(tx, teamId, input.assigneeId);
        return taskItem(await tx.task.create({ data: { ...input, teamId, creatorId: userId } }));
      });
    },
    getTask(teamId: string, userId: string, id: string) {
      return withTeamMember(db, teamId, userId, async (tx) => taskItem(await findTask(tx, teamId, id)));
    },
    getIdea(teamId: string, userId: string, id: string) {
      return withTeamMember(db, teamId, userId, async (tx) => ideaItem(await findIdea(tx, teamId, id)));
    },
    updateTask(teamId: string, userId: string, id: string, input: TaskChanges) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        const task = await findTask(tx, teamId, id);
        if (task.version !== input.version) throw conflict();
        await assignee(tx, teamId, input.assigneeId);
        return taskItem(await tx.task.update({ where: { id }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.status !== undefined ? { status: input.status } : {}), ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}), version: { increment: 1 } } }));
      });
    },
    removeTask(teamId: string, userId: string, id: string, version: number) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        const task = await findTask(tx, teamId, id);
        if (task.version !== version) throw conflict();
        await tx.task.delete({ where: { id } });
      });
    },
    listIdeas(teamId: string, userId: string, filters: Pick<Filters, 'q' | 'cursor'> = {}) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        if (filters.cursor && !await tx.idea.findFirst({ where: { id: filters.cursor, teamId } })) throw new HttpError(400, 'INVALID_CURSOR');
        const rows = await tx.idea.findMany({ where: { teamId, ...(filters.q ? { OR: [{ title: { contains: filters.q, mode: 'insensitive' } }, { description: { contains: filters.q, mode: 'insensitive' } }] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51, ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}) });
        return { ideas: rows.slice(0, 50).map(ideaItem), nextCursor: rows.length > 50 ? rows[49]?.id ?? null : null };
      });
    },
    createIdea(teamId: string, userId: string, input: IdeaInput) {
      return withTeamMember(db, teamId, userId, async (tx) => ideaItem(await tx.idea.create({ data: { ...input, teamId, creatorId: userId } })));
    },
    updateIdea(teamId: string, userId: string, id: string, input: IdeaChanges) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        const idea = await findIdea(tx, teamId, id);
        if (idea.convertedAt) throw new HttpError(409, 'IDEA_CONVERTED');
        if (idea.version !== input.version) throw conflict();
        return ideaItem(await tx.idea.update({ where: { id }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), version: { increment: 1 } } }));
      });
    },
    removeIdea(teamId: string, userId: string, id: string, version: number) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        const idea = await findIdea(tx, teamId, id);
        if (idea.version !== version) throw conflict();
        await tx.idea.delete({ where: { id } });
      });
    },
    convertIdea(teamId: string, userId: string, id: string, version: number) {
      return withTeamMember(db, teamId, userId, async (tx) => {
        const idea = await findIdea(tx, teamId, id);
        if (idea.convertedAt) {
          if (!idea.taskId) throw new HttpError(409, 'CONVERTED_TASK_DELETED');
          return { idea: ideaItem(idea), task: taskItem(await findTask(tx, teamId, idea.taskId)), created: false };
        }
        if (idea.version !== version) throw conflict();
        const task = await tx.task.create({ data: { teamId, creatorId: userId, title: idea.title, description: idea.description } });
        const updated = await tx.idea.update({ where: { id }, data: { taskId: task.id, convertedAt: new Date(), version: { increment: 1 } } });
        return { idea: ideaItem(updated), task: taskItem(task), created: true };
      });
    },
  };
}

export type WorkService = ReturnType<typeof createWorkService>;

