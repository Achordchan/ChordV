-- Progress visibility for running update/rollback/restart operations. `phase` is a
-- free-text lifecycle stage validated in the service (app-side phases come from the
-- shared SystemUpdateOperationPhase union); `progress` is 0-100 byte progress that is
-- only meaningful while phase is "downloading". Both are cosmetic best-effort fields:
-- a write failure must never gate the update itself.

ALTER TABLE "SystemUpdateOperation" ADD COLUMN "phase" TEXT,
ADD COLUMN "progress" INTEGER;
