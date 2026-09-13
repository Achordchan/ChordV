CREATE TABLE "RuntimeComponentDelivery" (
  "componentId" TEXT PRIMARY KEY, "sourceUrl" TEXT NOT NULL,
  "selectedVersion" TEXT, "autoLatest" BOOLEAN NOT NULL DEFAULT false,
  "activeVersionId" TEXT, "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "RuntimeComponentVersion" (
  "id" TEXT PRIMARY KEY, "componentId" TEXT NOT NULL, "sourceUrl" TEXT NOT NULL,
  "requestedVersion" TEXT, "versionLabel" TEXT, "resolvedUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued', "fileName" TEXT, "storedFilePath" TEXT,
  "fileSizeBytes" BIGINT, "fileHash" TEXT, "bytesReceived" BIGINT NOT NULL DEFAULT 0,
  "lastError" TEXT, "autoActivate" BOOLEAN NOT NULL DEFAULT false,
  "publishedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RuntimeComponentVersion_componentId_createdAt_idx" ON "RuntimeComponentVersion"("componentId", "createdAt");
CREATE INDEX "RuntimeComponentVersion_status_updatedAt_idx" ON "RuntimeComponentVersion"("status", "updatedAt");
ALTER TABLE "RuntimeComponentDelivery" ADD CONSTRAINT "RuntimeComponentDelivery_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "RuntimeComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuntimeComponentVersion" ADD CONSTRAINT "RuntimeComponentVersion_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "RuntimeComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
