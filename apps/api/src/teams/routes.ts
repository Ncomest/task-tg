import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError } from '../auth/telegram.js';
import { HttpError } from '../errors.js';
import type { TeamService } from './service.js';

const id = z.uuid();
const teamParams = z.object({ teamId: id });
const memberParams = teamParams.extend({ userId: id });
const inviteParams = teamParams.extend({ inviteId: id });
const teamInput = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') }).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'INVALID_REQUEST');
  return result.data;
}

function userId(request: FastifyRequest) {
  if (!request.currentUser) throw new AuthError();
  return request.currentUser.id;
}

export function registerTeamRoutes(app: FastifyInstance, teams: TeamService) {
  app.get('/api/teams', async (request) => ({ teams: await teams.list(userId(request)) }));
  app.post('/api/teams', async (request, reply) => reply.code(201).send({ team: await teams.create(userId(request), parse(teamInput, request.body)) }));
  app.get('/api/teams/:teamId', async (request) => ({ team: await teams.get(parse(teamParams, request.params).teamId, userId(request)) }));
  app.patch('/api/teams/:teamId', async (request) => ({ team: await teams.update(parse(teamParams, request.params).teamId, userId(request), parse(teamInput, request.body)) }));
  app.delete('/api/teams/:teamId', async (request, reply) => { await teams.remove(parse(teamParams, request.params).teamId, userId(request)); return reply.code(204).send(); });
  app.post('/api/teams/:teamId/leave', async (request, reply) => { await teams.leave(parse(teamParams, request.params).teamId, userId(request)); return reply.code(204).send(); });
  app.patch('/api/teams/:teamId/members/:userId', async (request) => {
    const params = parse(memberParams, request.params);
    const body = parse(z.object({ role: z.enum(['ADMIN', 'MEMBER']) }).strict(), request.body);
    return { team: await teams.changeRole(params.teamId, userId(request), params.userId, body.role) };
  });
  app.delete('/api/teams/:teamId/members/:userId', async (request, reply) => {
    const params = parse(memberParams, request.params);
    await teams.removeMember(params.teamId, userId(request), params.userId);
    return reply.code(204).send();
  });
  app.get('/api/teams/:teamId/invites', async (request) => ({ invites: await teams.listInvites(parse(teamParams, request.params).teamId, userId(request)) }));
  app.post('/api/teams/:teamId/invites', async (request, reply) => reply.code(201).send({ invite: await teams.createInvite(parse(teamParams, request.params).teamId, userId(request)) }));
  app.delete('/api/teams/:teamId/invites/:inviteId', async (request, reply) => {
    const params = parse(inviteParams, request.params);
    await teams.revokeInvite(params.teamId, userId(request), params.inviteId);
    return reply.code(204).send();
  });
  app.post('/api/teams/join', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[\w-]{43}$/) }).strict(), request.body);
    return { team: await teams.join(userId(request), token) };
  });
}
