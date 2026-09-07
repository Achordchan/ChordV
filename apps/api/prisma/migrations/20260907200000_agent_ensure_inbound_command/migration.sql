-- ENSURE_INBOUND: the control plane orders the agent to deploy the node's
-- VLESS/Reality inbound. Kept in its own migration and never used in the same
-- transaction that adds it — Postgres refuses a new enum value used before the
-- adding transaction commits, and ALTER TYPE ... ADD VALUE cannot be rolled back.
ALTER TYPE "NodeAgentCommandType" ADD VALUE IF NOT EXISTS 'ENSURE_INBOUND';
