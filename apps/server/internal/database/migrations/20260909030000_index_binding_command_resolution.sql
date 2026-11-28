CREATE INDEX "NodeCommandJob_bindingId_status_resolvedAt_commandType_idx"
ON "NodeCommandJob"("bindingId", "status", "resolvedAt", "commandType");
