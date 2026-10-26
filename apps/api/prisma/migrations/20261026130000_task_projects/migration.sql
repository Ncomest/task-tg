CREATE TYPE "Project" AS ENUM ('TG_BUDGET', 'TASK_TG');

ALTER TABLE "Task" ADD COLUMN "project" "Project";
ALTER TABLE "Idea" ADD COLUMN "project" "Project";
ALTER TABLE "AgentRun" ADD COLUMN "project" "Project";
