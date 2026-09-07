-- Agent-native node onboarding (docs/prd/node-revision-agent-native.md, R1).
-- registrationStatus tracks the pending_register -> agent_ready lifecycle for
-- nodes created through the new flow; null keeps legacy xui nodes untouched.
CREATE TYPE "NodeRegistrationStatus" AS ENUM ('pending_register', 'agent_ready');

ALTER TABLE "Node" ADD COLUMN "registrationStatus" "NodeRegistrationStatus";

-- One-time, short-lived registration credentials. The plaintext token only ever
-- travels inside the install command; only its SHA256 hash is stored.
CREATE TABLE "AgentRegisterToken" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRegisterToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentRegisterToken_tokenHash_key" ON "AgentRegisterToken"("tokenHash");

CREATE INDEX "AgentRegisterToken_nodeId_usedAt_idx" ON "AgentRegisterToken"("nodeId", "usedAt");

ALTER TABLE "AgentRegisterToken" ADD CONSTRAINT "AgentRegisterToken_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
