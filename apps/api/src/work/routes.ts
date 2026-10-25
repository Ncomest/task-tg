import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';
import type { WorkService } from './service.js';

const params = z.object({ teamId: z.uuid() });
const resource = params.extend({ id: z.uuid() });
const title = z.string().trim().min(1).max(160);
const description = z.string().trim().max(5000);
const status = z.enum(['TODO', 'IN_PROGRESS', 'DONE']);
const assigneeId = z.uuid().nullable();
const version = z.number().int().positive().max(2147483646);
const ideaBody = z.object({ title, description: description.default('') }).strict();
const ideaPatch = z.object({ version, title: title.optional(), description: description.optional() }).strict().refine((value) => Object.keys(value).length > 1);
const taskBody = z.object({ title, description: description.default(''), status: status.default('TODO'), assigneeId: assigneeId.default(null) }).strict();
const taskPatch = z.object({ version, title: title.optional(), description: description.optional(), status: status.optional(), assigneeId: assigneeId.optional() }).strict().refine((value) => Object.keys(value).length > 1);
const query = z.object({ q: z.string().trim().max(160).optional(), cursor: z.uuid().optional() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'INVALID_REQUEST');
  return result.data;
}
const actor = (request: FastifyRequest) => {
  if (!request.currentUser) throw new HttpError(401, 'UNAUTHORIZED');
  return request.currentUser.id;
};

export function registerWorkRoutes(app: FastifyInstance, work: WorkService) {
  app.get('/api/teams/:teamId/tasks/:id', async (request) => { const p = parse(resource, request.params); return { task: await work.getTask(p.teamId, actor(request), p.id) }; });
  app.get('/api/teams/:teamId/tasks', (request) => work.listTasks(parse(params, request.params).teamId, actor(request), parse(query.extend({ status: status.optional(), assignee: z.union([z.uuid(), z.enum(['me', 'unassigned'])]).optional() }), request.query)));
  app.post('/api/teams/:teamId/tasks', async (request, reply) => reply.code(201).send({ task: await work.createTask(parse(params, request.params).teamId, actor(request), parse(taskBody, request.body)) }));
  app.patch('/api/teams/:teamId/tasks/:id', async (request) => { const p = parse(resource, request.params); return { task: await work.updateTask(p.teamId, actor(request), p.id, parse(taskPatch, request.body)) }; });
  app.delete('/api/teams/:teamId/tasks/:id', async (request, reply) => { const p = parse(resource, request.params); await work.removeTask(p.teamId, actor(request), p.id, parse(z.object({ version }).strict(), request.body).version); return reply.code(204).send(); });
}

export function registerIdeaRoutes(app: FastifyInstance, work: WorkService) {
  app.get('/api/teams/:teamId/ideas/:id', async (request) => { const p = parse(resource, request.params); return { idea: await work.getIdea(p.teamId, actor(request), p.id) }; });
  app.get('/api/teams/:teamId/ideas', (request) => work.listIdeas(parse(params, request.params).teamId, actor(request), parse(query, request.query)));
  app.post('/api/teams/:teamId/ideas', async (request, reply) => reply.code(201).send({ idea: await work.createIdea(parse(params, request.params).teamId, actor(request), parse(ideaBody, request.body)) }));
  app.patch('/api/teams/:teamId/ideas/:id', async (request) => { const p = parse(resource, request.params); return { idea: await work.updateIdea(p.teamId, actor(request), p.id, parse(ideaPatch, request.body)) }; });
  app.delete('/api/teams/:teamId/ideas/:id', async (request, reply) => { const p = parse(resource, request.params); await work.removeIdea(p.teamId, actor(request), p.id, parse(z.object({ version }).strict(), request.body).version); return reply.code(204).send(); });
  app.post('/api/teams/:teamId/ideas/:id/convert', async (request) => { const p = parse(resource, request.params); return work.convertIdea(p.teamId, actor(request), p.id, parse(z.object({ version }).strict(), request.body).version); });
}

