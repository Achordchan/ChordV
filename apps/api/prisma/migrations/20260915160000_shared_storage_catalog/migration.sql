CREATE TABLE "StorageCatalogSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "payload" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
