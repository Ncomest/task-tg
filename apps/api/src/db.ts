import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './env.js';

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 }),
});
