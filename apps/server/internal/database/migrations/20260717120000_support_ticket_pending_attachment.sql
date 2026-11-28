-- Persist support-ticket pending attachments so upload tokens survive process restarts and multi-instance deploys.
CREATE TABLE "SupportTicketPendingAttachment" (
    "tokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "providerFileId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" BIGINT,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicketPendingAttachment_pkey" PRIMARY KEY ("tokenId")
);

CREATE INDEX "SupportTicketPendingAttachment_expiresAt_consumed_idx" ON "SupportTicketPendingAttachment"("expiresAt", "consumed");
CREATE INDEX "SupportTicketPendingAttachment_userId_ticketId_createdAt_idx" ON "SupportTicketPendingAttachment"("userId", "ticketId", "createdAt");
CREATE INDEX "SupportTicketPendingAttachment_ticketId_createdAt_idx" ON "SupportTicketPendingAttachment"("ticketId", "createdAt");
