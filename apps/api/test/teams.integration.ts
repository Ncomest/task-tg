import assert from 'node:assert/strict';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createTeamService, hashInvite } from '../src/teams/service.js';
import { HttpError } from '../src/errors.js';
import { buildApp } from '../src/app.js';
import { AuthError } from '../src/auth/telegram.js';
import type { CreatedTeamInvite, CurrentUser } from '@task-tg/shared';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== '/task_tg_auth_test') throw new Error('Requires disposable task_tg_auth_test database');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const teams = createTeamService(db);
const origin = 'https://team-test.example';
const actors: CurrentUser[] = [];
const tokens = new Map<string, CurrentUser>();
for (let index = 0; index < 6; index++) {
  const user = await db.user.create({ data: { telegramId: BigInt(910000001 + index), firstName: `Team actor ${index}` } });
  const actor = { id: user.id, telegramId: String(user.telegramId), firstName: user.firstName, lastName: null, username: null };
  actors.push(actor);
  tokens.set(String.fromCharCode(65 + index).repeat(43), actor);
}
const [owner, admin, first, second, other, raceUser] = actors;
assert.ok(owner && admin && first && second && other && raceUser);
const app = await buildApp({
  checkDatabase: async () => {}, closeDatabase: async () => {}, logLevel: 'silent', appOrigin: origin,
  auth: { login: async () => { throw new AuthError(); }, currentUser: async (token) => tokens.get(token ?? '') ?? null, logout: async () => {} },
  teams,
});
const request = (actor: CurrentUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
  const token = [...tokens].find(([, value]) => value.id === actor.id)?.[0];
  return app.inject({ method, url, headers: { origin, cookie: `tasktg_dev=${token}` }, ...(payload ? { payload } : {}) });
};
const rejects = (run: Promise<unknown>, code: string) => assert.rejects(run, (error) => error instanceof HttpError && error.code === code);

try {
  assert.equal((await app.inject('/api/teams')).statusCode, 401);
  const invalid = await request(owner, 'POST', '/api/teams', { name: '   ' });
  assert.equal(invalid.statusCode, 400);
  const created = await request(owner, 'POST', '/api/teams', { name: ' Private team ', description: 'Only members' });
  assert.equal(created.statusCode, 201);
  const teamId = created.json().team.id as string;
  assert.equal(created.json().team.name, 'Private team');
  const foreign = await teams.create(other.id, { name: 'Other team', description: '' });
  assert.equal((await teams.list(owner.id)).some((team) => team.id === foreign.id), false);
  await rejects(teams.get(teamId, other.id), 'TEAM_NOT_FOUND');
  await rejects(teams.get(foreign.id, owner.id), 'TEAM_NOT_FOUND');
  await rejects(teams.update(teamId, other.id, { name: 'Stolen', description: '' }), 'TEAM_NOT_FOUND');
  await rejects(teams.remove(teamId, other.id), 'TEAM_NOT_FOUND');
  await rejects(teams.leave(teamId, owner.id), 'OWNER_CANNOT_LEAVE');
  await rejects(teams.changeRole(teamId, owner.id, owner.id, 'MEMBER'), 'OWNER_ROLE_IMMUTABLE');

  const inviteResponse = await request(owner, 'POST', `/api/teams/${teamId}/invites`, {});
  assert.equal(inviteResponse.statusCode, 201);
  const adminInvite = inviteResponse.json().invite as CreatedTeamInvite;
  await rejects(teams.join(owner.id, adminInvite.token), 'ALREADY_MEMBER');
  assert.equal((await db.teamInvite.findUniqueOrThrow({ where: { id: adminInvite.id } })).usedAt, null);
  const joined = await request(admin, 'POST', '/api/teams/join', { token: adminInvite.token });
  assert.equal(joined.statusCode, 200);
  assert.equal(joined.json().team.role, 'MEMBER');
  await teams.changeRole(teamId, owner.id, admin.id, 'ADMIN');
  const updated = await request(admin, 'PATCH', `/api/teams/${teamId}`, { name: 'Renamed team', description: 'Updated' });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().team.name, 'Renamed team');
  assert.equal((await request(admin, 'DELETE', `/api/teams/${teamId}`)).statusCode, 403);
  assert.equal((await request(admin, 'PATCH', `/api/teams/${teamId}/members/${owner.id}`, { role: 'MEMBER' })).statusCode, 403);
  assert.equal((await request(owner, 'PATCH', `/api/teams/${teamId}/members/${admin.id}`, { role: 'OWNER' })).statusCode, 400);

  const invite = await teams.createInvite(teamId, admin.id);
  const stored = await db.teamInvite.findUniqueOrThrow({ where: { id: invite.id } });
  assert.equal(stored.tokenHash, hashInvite(invite.token));
  assert.notEqual(stored.tokenHash, invite.token);
  const list = await request(owner, 'GET', `/api/teams/${teamId}/invites`);
  assert.equal(list.body.includes(invite.token), false);
  assert.equal(list.body.includes('tokenHash'), false);
  const joins = await Promise.allSettled([teams.join(first.id, invite.token), teams.join(second.id, invite.token)]);
  assert.equal(joins.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedJoin = joins.find((result) => result.status === 'rejected');
  assert.ok(rejectedJoin && rejectedJoin.status === 'rejected' && rejectedJoin.reason instanceof HttpError);
  assert.equal(rejectedJoin.reason.code, 'INVITE_UNAVAILABLE');
  const member = joins[0]?.status === 'fulfilled' ? first : second;
  const outsider = member.id === first.id ? second : first;
  assert.equal((await teams.get(teamId, member.id)).role, 'MEMBER');
  await rejects(teams.get(teamId, outsider.id), 'TEAM_NOT_FOUND');
  await rejects(teams.createInvite(teamId, member.id), 'FORBIDDEN');
  await rejects(teams.listInvites(teamId, member.id), 'FORBIDDEN');
  await rejects(teams.update(teamId, member.id, { name: 'No', description: '' }), 'FORBIDDEN');
  await rejects(teams.changeRole(teamId, member.id, member.id, 'ADMIN'), 'FORBIDDEN');
  await rejects(teams.removeMember(teamId, admin.id, owner.id), 'FORBIDDEN');
  const secondAdminInvite = await teams.createInvite(teamId, owner.id);
  await teams.join(other.id, secondAdminInvite.token);
  await teams.changeRole(teamId, owner.id, other.id, 'ADMIN');
  await rejects(teams.removeMember(teamId, admin.id, other.id), 'FORBIDDEN');
  await teams.removeMember(teamId, owner.id, other.id);
  await teams.removeMember(teamId, admin.id, member.id);
  await rejects(teams.get(teamId, member.id), 'TEAM_NOT_FOUND');
  const memberReturn = await teams.createInvite(teamId, owner.id);
  await teams.join(member.id, memberReturn.token);

  const expired = await teams.createInvite(teamId, owner.id);
  await db.teamInvite.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
  await rejects(teams.join(outsider.id, expired.token), 'INVITE_UNAVAILABLE');
  const revoked = await teams.createInvite(teamId, owner.id);
  assert.equal((await request(admin, 'DELETE', `/api/teams/${teamId}/invites/${revoked.id}`)).statusCode, 204);
  await rejects(teams.join(outsider.id, revoked.token), 'INVITE_UNAVAILABLE');
  const otherInvite = await teams.createInvite(foreign.id, other.id);
  await rejects(teams.revokeInvite(teamId, owner.id, otherInvite.id), 'INVITE_UNAVAILABLE');
  assert.equal((await db.teamInvite.findUniqueOrThrow({ where: { id: otherInvite.id } })).revokedAt, null);

  const beforeDemotion = await teams.createInvite(teamId, admin.id);
  await teams.changeRole(teamId, owner.id, admin.id, 'MEMBER');
  await rejects(teams.join(outsider.id, beforeDemotion.token), 'INVITE_UNAVAILABLE');
  await teams.changeRole(teamId, owner.id, admin.id, 'ADMIN');
  await rejects(teams.join(outsider.id, beforeDemotion.token), 'INVITE_UNAVAILABLE');
  const beforeLeaving = await teams.createInvite(teamId, admin.id);
  await teams.leave(teamId, admin.id);
  await rejects(teams.join(outsider.id, beforeLeaving.token), 'INVITE_UNAVAILABLE');
  await rejects(teams.get(teamId, admin.id), 'TEAM_NOT_FOUND');

  const raceInvite = await teams.createInvite(teamId, owner.id);
  const race = await Promise.allSettled([teams.join(raceUser.id, raceInvite.token), teams.revokeInvite(teamId, owner.id, raceInvite.id)]);
  assert.equal(race[1]?.status, 'fulfilled');
  const raced = await db.teamInvite.findUniqueOrThrow({ where: { id: raceInvite.id } });
  const raceMembership = await db.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId: raceUser.id } } });
  assert.equal(!!raceMembership, !!raced.usedAt);
  assert.equal(!!raced.usedAt && !!raced.revokedAt, false);
  assert.equal(race[0]?.status === 'fulfilled', !!raceMembership);

  await teams.removeMember(teamId, owner.id, member.id);
  await rejects(teams.get(teamId, member.id), 'TEAM_NOT_FOUND');
  const returnInvite = await teams.createInvite(teamId, owner.id);
  await teams.join(member.id, returnInvite.token);
  assert.equal((await request(member, 'POST', `/api/teams/${teamId}/leave`, {})).statusCode, 204);
  await rejects(teams.get(teamId, member.id), 'TEAM_NOT_FOUND');
  await rejects(teams.join(member.id, returnInvite.token), 'INVITE_UNAVAILABLE');
  const deleted = await request(owner, 'DELETE', `/api/teams/${teamId}`);
  assert.equal(deleted.statusCode, 204);
  assert.equal(await db.teamMembership.count({ where: { teamId } }), 0);
  assert.equal(await db.teamInvite.count({ where: { teamId } }), 0);
  await rejects(teams.get(teamId, owner.id), 'TEAM_NOT_FOUND');
  await teams.remove(foreign.id, other.id);
  console.log('PASS: teams CRUD, private data isolation, owner/admin/member policies, hashed and single-use invites, concurrent join/revoke, demotion, removal, leave and cascading deletion');
} finally {
  await app.close();
  await db.$disconnect();
}
