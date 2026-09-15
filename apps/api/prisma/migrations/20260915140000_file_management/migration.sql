ALTER TABLE "ReleaseArtifact" ADD COLUMN "sourceUrl" TEXT;
CREATE INDEX "ReleaseArtifact_fileHash_fileSizeBytes_idx" ON "ReleaseArtifact"("fileHash", "fileSizeBytes");
CREATE TABLE "FileCleanupJob" (
 "blocked" BOOLEAN NOT NULL DEFAULT false,
 "id" TEXT PRIMARY KEY, "path" TEXT NOT NULL UNIQUE, "reason" TEXT NOT NULL,
 "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "FileCleanupJob_blocked_nextAttemptAt_idx" ON "FileCleanupJob"("blocked", "nextAttemptAt");
UPDATE "ReleaseArtifact" SET "sourceUrl" = "downloadUrl" WHERE "source" = 'external';
ALTER TABLE "RuntimeComponentVersion" ADD COLUMN "retainUntil" TIMESTAMP(3);
-- The old schema did not record deactivation time; conservatively give already-distributed files a transition grace period.
UPDATE "RuntimeComponentVersion" SET "retainUntil" = CURRENT_TIMESTAMP + INTERVAL '30 days' WHERE "publishedAt" IS NOT NULL;
