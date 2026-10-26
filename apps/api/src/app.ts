import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { CurrentUser, HealthResponse, ReadinessResponse } from '@task-tg/shared';
import type { AuthService } from './auth/service.js';
import { AuthError } from './auth/telegram.js';
import { HttpError } from './errors.js';
import type { AgentService } from './agent/service.js';
import { registerAgentRoutes } from './agent/routes.js';
import { registerTeamRoutes } from './teams/routes.js';
import type { TeamService } from './teams/service.js';
import { registerIdeaRoutes, registerWorkRoutes } from './work/routes.js';
import type { WorkService } from './work/service.js';

declare module 'fastify' {
  interface FastifyContextConfig { public?: boolean; agent?: boolean }
  interface FastifyRequest { currentUser: CurrentUser | null }
}

interface Dependencies {
  checkDatabase: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  logLevel?: string;
  auth?: AuthService;
  appOrigin?: string;
  secureCookies?: boolean;
  sessionTtlSeconds?: number;
  teams?: TeamService;
  work?: WorkService;
  agent?: AgentService;
  agentWorkerToken?: string;
}

export async function buildApp(dependencies: Dependencies) {
  const app = Fastify({ bodyLimit: 32768, logger: { level: dependencies.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  await app.register(cookie);
  // Authenticated requests are limited per user; public requests use the direct IP.
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', cache: 1000, hook: 'preHandler', keyGenerator: (request) => request.currentUser?.id ?? request.ip });
  app.decorateRequest('currentUser', null);
  const secure = dependencies.secureCookies ?? false;
  const cookieName = secure ? '__Host-tasktg' : 'tasktg_dev';
  const cookieOptions = { path: '/', httpOnly: true, secure, sameSite: secure ? 'none' as const : 'lax' as const, partitioned: secure };
  const authService = () => {
    if (!dependencies.auth) throw new AuthError(503, 'AUTH_NOT_CONFIGURED');
    return dependencies.auth;
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.code });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'Request failed');
    return reply.code(status).send({ error: status === 429 ? 'TOO_MANY_REQUESTS' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR' });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    // Worker endpoints authenticate with a bearer token and are called server-to-server,
    // so they have neither a Telegram session cookie nor a browser Origin header.
    if (request.routeOptions.config.agent) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== (dependencies.appOrigin ?? 'http://localhost:5173')) {
      throw new AuthError(403, 'ORIGIN_NOT_ALLOWED');
    }
    if (!request.routeOptions.config.public) {
      const user = await authService().currentUser(request.cookies[cookieName]);
      if (!user) throw new AuthError();
      request.currentUser = user;
    }
  });

  app.get<{ Reply: HealthResponse }>('/api/health', { config: { public: true, rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get<{ Reply: ReadinessResponse }>('/api/ready', { config: { public: true, rateLimit: false } }, async (request, reply) => {
    try {
      await dependencies.checkDatabase();
      return { status: 'ok', database: 'connected' };
    } catch (error) {
      request.log.error({ err: error }, 'Database readiness check failed');
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  app.post<{ Body: { initData: string } }>('/api/auth/telegram', {
    config: { public: true, rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['initData'], properties: { initData: { type: 'string', minLength: 1, maxLength: 16384 } } } },
  }, async (request, reply) => {
    const auth = authService();
    const result = await auth.login(request.body.initData);
    await auth.logout(request.cookies[cookieName]);
    reply.setCookie(cookieName, result.token, { ...cookieOptions, maxAge: dependencies.sessionTtlSeconds ?? 604800, expires: result.expiresAt });
    return { user: result.user };
  });
  app.get('/api/me', async (request) => ({ user: request.currentUser }));
  app.post('/api/auth/logout', { config: { public: true } }, async (request, reply) => {
    await authService().logout(request.cookies[cookieName]);
    return reply.clearCookie(cookieName, cookieOptions).code(204).send();
  });
  app.addHook('onClose', async () => dependencies.closeDatabase());
  if (dependencies.teams) registerTeamRoutes(app, dependencies.teams);
  if (dependencies.work) {
    registerWorkRoutes(app, dependencies.work);
    registerIdeaRoutes(app, dependencies.work);
  }
  if (dependencies.agent) registerAgentRoutes(app, dependencies.agent, dependencies.agentWorkerToken);
  return app;
}


