import type { CurrentUser } from '@task-tg/shared';
import { Prisma, type PrismaClient, type User } from '../generated/prisma/client.js';
import type { AuthStore } from './service.js';

function publicUser(user: User): CurrentUser {
  return { id: user.id, telegramId: user.telegramId.toString(), firstName: user.firstName, lastName: user.lastName, username: user.username };
}

export function createPrismaAuthStore(db: PrismaClient): AuthStore {
  return {
    async createSession(input) {
      try {
        return await db.$transaction(async (transaction) => {
          await transaction.usedInitData.deleteMany({ where: { expiresAt: { lte: input.now } } });
          await transaction.session.deleteMany({ where: { expiresAt: { lte: input.now } } });
          await transaction.usedInitData.create({ data: { hash: input.grantHash, expiresAt: input.grantExpiresAt } });
          const profile = { firstName: input.user.first_name, lastName: input.user.last_name ?? null, username: input.user.username ?? null };
          const user = await transaction.user.upsert({
            where: { telegramId: BigInt(input.user.id) },
            create: { telegramId: BigInt(input.user.id), ...profile },
            update: profile,
          });
          await transaction.session.create({ data: { tokenHash: input.tokenHash, userId: user.id, expiresAt: input.expiresAt } });
          return publicUser(user);
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
        throw error;
      }
    },
    async findSession(hash) {
      const session = await db.session.findUnique({ where: { tokenHash: hash }, include: { user: true } });
      return session ? { user: publicUser(session.user), expiresAt: session.expiresAt } : null;
    },
    async deleteSession(hash) { await db.session.deleteMany({ where: { tokenHash: hash } }); },
  };
}
