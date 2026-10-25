import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

export const env = z.object({
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:\/\//.test(value), 'Expected PostgreSQL URL'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/).optional(),
  APP_ORIGIN: z.url().refine((value) => new URL(value).origin === value, 'Use an origin without path or trailing slash').default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800),
}).parse(process.env);

if (env.COOKIE_SECURE && !env.APP_ORIGIN.startsWith('https://')) throw new Error('Secure cookies require HTTPS APP_ORIGIN');
if (env.TELEGRAM_BOT_TOKEN && !env.COOKIE_SECURE && !['localhost', '127.0.0.1'].includes(new URL(env.APP_ORIGIN).hostname)) {
  throw new Error('Telegram authentication outside localhost requires secure cookies');
}
