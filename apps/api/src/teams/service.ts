import { createHash, randomBytes } from 'node:crypto';
import type { TeamRole, TeamDetail, TeamSummary, TeamInviteSummary } from '@task-tg/shared';
import type { Prisma, PrismaClient, Team, TeamInvite } from '../generated/prisma/client.js';
import { HttpError } from '../errors.js';
import { lockTeam, withTeamMember } from './access.js';

type Tx = Prisma.TransactionClient;
const forbidden = () => new HttpError(403, 'FORBIDDEN');
const unavailable = () => new HttpError(404, 'INVITE_UNAVAILABLE');

export function hashInvite(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createTeamService(db: PrismaClient, now = () => new Date()) {
  // All team operations lock the same parent row before checking membership.
  // This serializes role changes, departures, invite redemption and deletion.
  function withMember<T>(teamId: string, userId: string, run: (tx: Tx, team: Team, role: TeamRole) => Promise<T>) {
    return withTeamMember(db, teamId, userId, run);
  }

  function summary(team: Team, role: TeamRole, memberCount: number): TeamSummary {
    return { id: team.id, name: team.name, description: team.description, role, memberCount, createdAt: team.createdAt.toISOString() };
  }

  async function detail(tx: Tx, team: Team, role: TeamRole): Promise<TeamDetail> {
    const members = await tx.teamMembership.findMany({ where: { teamId: team.id }, include: { user: { select: { id: true, firstName: true, lastName: true, username: true } } }, orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] });
    return { ...summary(team, role, members.length), members: members.map(({ user, role }) => ({ userId: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, role })) };
  }

  const manager = (role: TeamRole) => { if (role === 'MEMBER') throw forbidden(); };
  const owner = (role: TeamRole) => { if (role !== 'OWNER') throw forbidden(); };
  const revokeIssuedBy = (tx: Tx, teamId: string, creatorId: string) => tx.teamInvite.updateMany({ where: { teamId, creatorId, usedAt: null, revokedAt: null }, data: { revokedAt: now() } });
  function inviteSummary(invite: TeamInvite): TeamInviteSummary {
    const status = invite.usedAt ? 'USED' : invite.revokedAt ? 'REVOKED' : invite.expiresAt <= now() ? 'EXPIRED' : 'ACTIVE';
    return { id: invite.id, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString(), status };
  }

  return {
    async list(userId: string) {
      const memberships = await db.teamMembership.findMany({ where: { userId }, include: { team: { include: { _count: { select: { memberships: true } } } } }, orderBy: { joinedAt: 'desc' } });
      return memberships.map(({ team, role }) => summary(team, role, team._count.memberships));
    },
    async create(userId: string, input: { name: string; description: string }) {
      const team = await db.team.create({ data: { ...input, memberships: { create: { userId, role: 'OWNER' } } } });
      return summary(team, 'OWNER', 1);
    },
    get(teamId: string, userId: string) {
      return withMember(teamId, userId, (tx, team, role) => detail(tx, team, role));
    },
    update(teamId: string, userId: string, input: { name: string; description: string }) {
      return withMember(teamId, userId, async (tx, team, role) => {
        manager(role);
        const updated = await tx.team.update({ where: { id: team.id }, data: input });
        return detail(tx, updated, role);
      });
    },
    remove(teamId: string, userId: string) {
      return withMember(teamId, userId, async (tx, team, role) => {
        owner(role);
        await tx.team.delete({ where: { id: team.id } });
      });
    },
    leave(teamId: string, userId: string) {
      return withMember(teamId, userId, async (tx, _team, role) => {
        if (role === 'OWNER') throw new HttpError(409, 'OWNER_CANNOT_LEAVE');
        await revokeIssuedBy(tx, teamId, userId);
        await tx.task.updateMany({ where: { teamId, assigneeId: userId }, data: { assigneeId: null, version: { increment: 1 } } });
        await tx.teamMembership.delete({ where: { teamId_userId: { teamId, userId } } });
      });
    },
    changeRole(teamId: string, actorId: string, userId: string, newRole: 'ADMIN' | 'MEMBER') {
      return withMember(teamId, actorId, async (tx, team, role) => {
        owner(role);
        const target = await tx.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } } });
        if (!target) throw new HttpError(404, 'MEMBER_NOT_FOUND');
        if (target.role === 'OWNER') throw new HttpError(409, 'OWNER_ROLE_IMMUTABLE');
        await tx.teamMembership.update({ where: { teamId_userId: { teamId, userId } }, data: { role: newRole } });
        if (newRole === 'MEMBER') await revokeIssuedBy(tx, teamId, userId);
        return detail(tx, team, role);
      });
    },
    removeMember(teamId: string, actorId: string, userId: string) {
      return withMember(teamId, actorId, async (tx, _team, role) => {
        manager(role);
        if (actorId === userId) throw new HttpError(409, 'USE_LEAVE');
        const target = await tx.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } } });
        if (!target) throw new HttpError(404, 'MEMBER_NOT_FOUND');
        if (target.role === 'OWNER' || (role === 'ADMIN' && target.role === 'ADMIN')) throw forbidden();
        await revokeIssuedBy(tx, teamId, userId);
        await tx.task.updateMany({ where: { teamId, assigneeId: userId }, data: { assigneeId: null, version: { increment: 1 } } });
        await tx.teamMembership.delete({ where: { teamId_userId: { teamId, userId } } });
      });
    },
    createInvite(teamId: string, userId: string) {
      return withMember(teamId, userId, async (tx, _team, role) => {
        manager(role);
        const date = now();
        const count = await tx.teamInvite.count({ where: { teamId, usedAt: null, revokedAt: null, expiresAt: { gt: date } } });
        if (count >= 20) throw new HttpError(409, 'TOO_MANY_ACTIVE_INVITES');
        const token = randomBytes(32).toString('base64url');
        const invite = await tx.teamInvite.create({ data: { teamId, creatorId: userId, tokenHash: hashInvite(token), expiresAt: new Date(date.getTime() + 86400000) } });
        return { ...inviteSummary(invite), token };
      });
    },
    listInvites(teamId: string, userId: string) {
      return withMember(teamId, userId, async (tx, _team, role) => {
        manager(role);
        const active = { teamId, usedAt: null, revokedAt: null, expiresAt: { gt: now() } };
        const [open, recent] = await Promise.all([
          tx.teamInvite.findMany({ where: active, orderBy: { createdAt: 'desc' } }),
          tx.teamInvite.findMany({ where: { teamId, NOT: active }, orderBy: { createdAt: 'desc' }, take: 30 }),
        ]);
        return [...open, ...recent].map(inviteSummary);
      });
    },
    revokeInvite(teamId: string, userId: string, inviteId: string) {
      return withMember(teamId, userId, async (tx, _team, role) => {
        manager(role);
        const invite = await tx.teamInvite.findFirst({ where: { id: inviteId, teamId } });
        if (!invite) throw unavailable();
        if (!invite.usedAt && !invite.revokedAt) await tx.teamInvite.update({ where: { id: invite.id }, data: { revokedAt: now() } });
      });
    },
    async join(userId: string, token: string) {
      if (!/^[\w-]{43}$/.test(token)) throw unavailable();
      const tokenHash = hashInvite(token);
      const candidate = await db.teamInvite.findUnique({ where: { tokenHash }, select: { teamId: true } });
      if (!candidate) throw unavailable();
      return db.$transaction(async (tx) => {
        // Same parent-first lock order as revocation and membership changes.
        let team: Team;
        try { team = await lockTeam(tx, candidate.teamId); } catch (error) {
          if (error instanceof HttpError && error.code === 'TEAM_NOT_FOUND') throw unavailable();
          throw error;
        }
        const invite = await tx.teamInvite.findUnique({ where: { tokenHash } });
        if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt <= now()) throw unavailable();
        const issuer = await tx.teamMembership.findUnique({ where: { teamId_userId: { teamId: team.id, userId: invite.creatorId } } });
        if (!issuer || issuer.role === 'MEMBER') throw unavailable();
        if (await tx.teamMembership.findUnique({ where: { teamId_userId: { teamId: team.id, userId } } })) throw new HttpError(409, 'ALREADY_MEMBER');
        await tx.teamMembership.create({ data: { teamId: team.id, userId, role: 'MEMBER' } });
        await tx.teamInvite.update({ where: { id: invite.id }, data: { usedAt: now(), usedById: userId } });
        return detail(tx, team, 'MEMBER');
      }, { maxWait: 5000, timeout: 10000 });
    },
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
