CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'AGENT');

ALTER TABLE "AgentRun" ADD COLUMN "context" TEXT;

CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "runId" TEXT,
    "authorId" TEXT,
    "role" "AgentMessageRole" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentMessage_taskId_createdAt_idx" ON "AgentMessage"("taskId", "createdAt");
CREATE INDEX "AgentMessage_teamId_createdAt_idx" ON "AgentMessage"("teamId", "createdAt");
CREATE INDEX "AgentMessage_runId_idx" ON "AgentMessage"("runId");

ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
