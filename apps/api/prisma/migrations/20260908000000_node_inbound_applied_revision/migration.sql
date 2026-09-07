-- Applied revision of the node's inbound deployment. The write-back is a single
-- conditional UPDATE against this column, so two concurrent ENSURE_INBOUND
-- results cannot interleave into a stale endpoint.
ALTER TABLE "Node" ADD COLUMN IF NOT EXISTS "inboundAppliedRevision" BIGINT NOT NULL DEFAULT 0;
