ALTER TABLE "Task" ADD COLUMN "archived_at" TIMESTAMP(3), ADD COLUMN "completed_at" TIMESTAMP(3);
CREATE INDEX "Task_teamId_archived_at_id_idx" ON "Task"("teamId", "archived_at", "id");
ALTER TABLE "Task" ADD CONSTRAINT "Task_archive_done_check" CHECK ("archived_at" IS NULL OR "status" = 'DONE');
