import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { AgentService, CompleteInput } from './service.js';

const teamTask = z.object({ teamId: z.uuid(), id: z.uuid() });
const runParams = z.object({ id: z.uuid() });
const cancelParams = teamTask.extend({ runId: z.uuid() });
const version = z.number().int().positive().max(2147483646);
const stage = z.enum(['ASSESSING', 'PLANNED', 'WORKING', 'REVIEW', 'NEEDS_INPUT']);
const message = z.string().trim().min(1).max(4000);
const summary = z.string().trim().min(1).max(20000);
const error = z.string().trim().min(1).max(4000);
const branch = z.string().trim().min(1).max(200).regex(/^[\w./-]+$/);
const pullRequestUrl = z.url().max(500).refine((value) => value.startsWith('https://github.com/'), 'Expected GitHub pull request URL');
const taskStatus = z.enum(['TODO', 'IN_PROGRESS', 'DONE']);
const lease = z.string().min(20).max(256);
const worker = z.object({ workerId: z.string().trim().min(1).max(120) }).strict();
const heartbeatBody = z.object({ leaseToken: lease }).strict();
const reportBody = z.object({ leaseToken: lease, stage: stage.optional(), message }).strict();
const chatMessageBody = z.object({ body: message }).strict();
const completeBody = z.object({
  leaseToken: lease,
  status: z.enum(['DONE', 'FAILED', 'NEEDS_INPUT']),
  summary: summary.optional(),
  branch: branch.optional(),
  pullRequestUrl: pullRequestUrl.optional(),
  error: error.optional(),
  taskStatus: taskStatus.optional(),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'INVALID_REQUEST');
  return result.data;
}

const actor = (request: FastifyRequest) => {
  if (!request.currentUser) throw new HttpError(401, 'UNAUTHORIZED');
  return request.currentUser.id;
};

function authorizeWorker(request: FastifyRequest, configuredToken: string | undefined) {
  if (!configuredToken) throw new HttpError(503, 'AGENT_NOT_CONFIGURED');
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
  if (!match?.[1]) throw new HttpError(401, 'AGENT_UNAUTHORIZED');
  const supplied = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(configuredToken).digest();
  if (!timingSafeEqual(supplied, expected)) throw new HttpError(401, 'AGENT_UNAUTHORIZED');
}

export function registerAgentRoutes(app: FastifyInstance, agent: AgentService, workerToken: string | undefined) {
  app.get('/api/teams/:teamId/tasks/:id/agent-runs', async (request) => {
    const p = parse(teamTask, request.params);
    return agent.listRuns(p.id, p.teamId, actor(request));
  });

  app.post('/api/teams/:teamId/tasks/:id/agent-runs', async (request, reply) => {
    if (!workerToken) throw new HttpError(503, 'AGENT_NOT_CONFIGURED');
    const p = parse(teamTask, request.params);
    const body = parse(z.object({ version }).strict(), request.body);
    return reply.code(201).send(await agent.createRun(p.id, p.teamId, actor(request), body.version));
  });

  app.get('/api/teams/:teamId/tasks/:id/agent-messages', async (request) => {
    const p = parse(teamTask, request.params);
    return agent.listMessages(p.id, p.teamId, actor(request));
  });

  app.post('/api/teams/:teamId/tasks/:id/agent-messages', async (request, reply) => {
    if (!workerToken) throw new HttpError(503, 'AGENT_NOT_CONFIGURED');
    const p = parse(teamTask, request.params);
    const body = parse(chatMessageBody, request.body);
    return reply.code(201).send(await agent.sendMessage(p.id, p.teamId, actor(request), body.body));
  });

  app.post('/api/teams/:teamId/tasks/:id/agent-runs/:runId/cancel', async (request) => {
    const p = parse(cancelParams, request.params);
    return agent.cancelRun(p.id, p.teamId, actor(request), p.runId);
  });

  app.post('/api/agent/runs/claim', { config: { public: true, agent: true } }, async (request, reply) => {
    authorizeWorker(request, workerToken);
    const body = parse(worker, request.body);
    const claim = await agent.claim(body.workerId);
    if (!claim) return reply.code(204).send();
    return { run: claim };
  });

  app.post('/api/agent/runs/:id/heartbeat', { config: { public: true, agent: true } }, async (request) => {
    authorizeWorker(request, workerToken);
    const p = parse(runParams, request.params);
    const body = parse(heartbeatBody, request.body);
    return agent.heartbeat(p.id, body.leaseToken);
  });

  // The per-run lease is the credential here: the agent process can report progress
  // without receiving the global worker token. Claim/heartbeat/complete stay worker-only.
  app.post('/api/agent/runs/:id/events', { config: { public: true, agent: true } }, async (request) => {
    const p = parse(runParams, request.params);
    const body = parse(reportBody, request.body);
    return agent.report(p.id, body.leaseToken, body.stage, body.message);
  });

  app.post('/api/agent/runs/:id/complete', { config: { public: true, agent: true } }, async (request) => {
    authorizeWorker(request, workerToken);
    const p = parse(runParams, request.params);
    const body = parse(completeBody, request.body);
    return agent.complete(p.id, body.leaseToken, body as CompleteInput);
  });
}
