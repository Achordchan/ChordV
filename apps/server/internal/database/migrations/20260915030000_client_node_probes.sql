CREATE TABLE "ClientNodeProbe" (
  "userId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "latencyMs" INTEGER,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientNodeProbe_pkey" PRIMARY KEY ("userId", "nodeId"),
  CONSTRAINT "ClientNodeProbe_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClientNodeProbe_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClientNodeProbe_observation_check" CHECK (("status" = 'healthy' AND "latencyMs" IS NOT NULL AND "latencyMs" BETWEEN 1 AND 60000) OR ("status" = 'offline' AND "latencyMs" IS NULL))
);
CREATE INDEX "ClientNodeProbe_checkedAt_nodeId_idx" ON "ClientNodeProbe"("checkedAt", "nodeId");
