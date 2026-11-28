-- resolvedAt marks a retry-exhausted (cancelled) command as superseded by a
-- newer command for the same target; the admin queue stops counting it as an
-- unresolved failure from then on. Existing cancelled rows keep reading as
-- unresolved until a repair re-orders the operation.
ALTER TABLE "NodeCommandJob" ADD COLUMN "resolvedAt" TIMESTAMP(3);
