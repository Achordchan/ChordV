-- Denormalize the owning binding onto the command row: the admin queue
-- aggregates user commands per subscription/user/team, and the payload JSON is
-- not queryable for that. Backfill from payload->>'bindingId' and the binding
-- table so commands enqueued before this migration keep their ownership.
ALTER TABLE "NodeCommandJob" ADD COLUMN "bindingId" TEXT;
ALTER TABLE "NodeCommandJob" ADD COLUMN "subscriptionId" TEXT;
ALTER TABLE "NodeCommandJob" ADD COLUMN "userId" TEXT;
ALTER TABLE "NodeCommandJob" ADD COLUMN "teamId" TEXT;

UPDATE "NodeCommandJob"
SET "bindingId" = "payload"->>'bindingId'
WHERE "bindingId" IS NULL AND "payload"->>'bindingId' IS NOT NULL;

UPDATE "NodeCommandJob" AS job
SET "subscriptionId" = binding."subscriptionId",
    "userId" = binding."userId",
    "teamId" = binding."teamId"
FROM "PanelClientBinding" AS binding
WHERE binding."id" = job."bindingId";

CREATE INDEX "NodeCommandJob_subscriptionId_status_idx" ON "NodeCommandJob"("subscriptionId", "status");
CREATE INDEX "NodeCommandJob_userId_status_idx" ON "NodeCommandJob"("userId", "status");
