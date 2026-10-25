import { buildApp } from './app.js';
import { db } from './db.js';
import { env } from './env.js';
import { createAuthService } from './auth/service.js';
import { createPrismaAuthStore } from './auth/store.js';
import { createTeamService } from './teams/service.js';
import { createWorkService } from './work/service.js';

const app = await buildApp({
  checkDatabase: async () => { await db.$queryRaw`SELECT 1`; },
  closeDatabase: async () => { await db.$disconnect(); },
  logLevel: env.LOG_LEVEL,
  appOrigin: env.APP_ORIGIN,
  secureCookies: env.COOKIE_SECURE,
  sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  teams: createTeamService(db),
  work: createWorkService(db),
  auth: createAuthService(createPrismaAuthStore(db), { botToken: env.TELEGRAM_BOT_TOKEN, initDataMaxAgeSeconds: env.INIT_DATA_MAX_AGE_SECONDS, sessionTtlSeconds: env.SESSION_TTL_SECONDS }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => { app.log.error(error); process.exitCode = 1; });
  });
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
