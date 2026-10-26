CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'ASSESSING', 'PLANNED', 'WORKING', 'REVIEW', 'DONE', 'FAILED', 'CANCELLED', 'NEEDS_INPUT');

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
  "taskVersion" INTEGER NOT NULL,
  "taskTitle" TEXT NOT NULL,
  "taskDescription" TEXT NOT NULL DEFAULT '',
  "summary" TEXT,
  "branch" TEXT,
  "pullRequestUrl" TEXT,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "workerId" TEXT,
  "leaseHash" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentEvent" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "stage" "AgentRunStatus",
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRun_taskId_createdAt_idx" ON "AgentRun"("taskId", "createdAt");
CREATE INDEX "AgentRun_teamId_createdAt_idx" ON "AgentRun"("teamId", "createdAt");
CREATE INDEX "AgentRun_status_leaseExpiresAt_idx" ON "AgentRun"("status", "leaseExpiresAt");
CREATE INDEX "AgentRun_createdById_idx" ON "AgentRun"("createdById");
CREATE INDEX "AgentEvent_runId_createdAt_idx" ON "AgentEvent"("runId", "createdAt");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
