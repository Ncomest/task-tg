export interface HealthResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'unavailable';
  database: 'connected' | 'unavailable';
}

export interface CurrentUser {
  id: string;
  telegramId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
}

export interface MeResponse {
  user: CurrentUser;
}

export type TeamRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface TeamSummary {
  id: string;
  name: string;
  description: string;
  role: TeamRole;
  memberCount: number;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  role: TeamRole;
}

export interface TeamDetail extends TeamSummary {
  members: TeamMember[];
}

export interface TeamInviteSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';
}

export interface CreatedTeamInvite extends TeamInviteSummary {
  token: string;
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface TaskItem {
  id: string;
  teamId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeId: string | null;
  creatorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaItem {
  id: string;
  teamId: string;
  title: string;
  description: string;
  creatorId: string;
  taskId: string | null;
  convertedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
