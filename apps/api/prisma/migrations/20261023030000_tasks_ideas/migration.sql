CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');
CREATE TABLE "Task" (
  "id" TEXT PRIMARY KEY,
  "teamId" TEXT NOT NULL REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
  "assigneeId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "creatorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Task_teamId_createdAt_id_idx" ON "Task"("teamId", "createdAt", "id");
CREATE INDEX "Task_teamId_assigneeId_status_idx" ON "Task"("teamId", "assigneeId", "status");
CREATE TABLE "Idea" (
  "id" TEXT PRIMARY KEY,
  "teamId" TEXT NOT NULL REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "creatorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "taskId" TEXT UNIQUE REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "convertedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Idea_teamId_createdAt_id_idx" ON "Idea"("teamId", "createdAt", "id");
