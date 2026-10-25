import type { TeamRole } from '@task-tg/shared';
import type { Prisma, PrismaClient, Team } from '../generated/prisma/client.js';
import { HttpError } from '../errors.js';

export async function lockTeam(tx: Prisma.TransactionClient, teamId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
  if (!rows.length) throw new HttpError(404, 'TEAM_NOT_FOUND');
  return tx.team.findUniqueOrThrow({ where: { id: teamId } });
}

export function withTeamMember<T>(db: PrismaClient, teamId: string, userId: string, run: (tx: Prisma.TransactionClient, team: Team, role: TeamRole) => Promise<T>) {
  return db.$transaction(async (tx) => {
    const team = await lockTeam(tx, teamId);
    const membership = await tx.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (!membership) throw new HttpError(404, 'TEAM_NOT_FOUND');
    return run(tx, team, membership.role);
  }, { maxWait: 5000, timeout: 10000 });
}
