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

/** Repository the task belongs to. The worker uses it to pick the worktree. */
export type Project = 'TG_BUDGET' | 'TASK_TG';

export interface TaskItem {
  id: string;
  teamId: string;
  title: string;
  description: string;
  status: TaskStatus;
  project: Project | null;
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
  project: Project | null;
  creatorId: string;
  taskId: string | null;
  convertedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus =
  | 'QUEUED'
  | 'ASSESSING'
  | 'PLANNED'
  | 'WORKING'
  | 'REVIEW'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'NEEDS_INPUT';

/** Stages an agent is allowed to report while a run is in progress. */
export type AgentRunStage = 'ASSESSING' | 'PLANNED' | 'WORKING' | 'REVIEW' | 'NEEDS_INPUT';

export interface AgentEventItem {
  id: string;
  runId: string;
  stage: AgentRunStatus | null;
  message: string;
  createdAt: string;
}

export interface AgentRunItem {
  id: string;
  taskId: string;
  teamId: string;
  createdById: string;
  status: AgentRunStatus;
  taskVersion: number;
  taskTitle: string;
  taskDescription: string;
  project: Project | null;
  summary: string | null;
  branch: string | null;
  pullRequestUrl: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: AgentEventItem[];
}

export interface AgentRunClaim extends AgentRunItem {
  leaseToken: string;
  leaseExpiresAt: string;
}
