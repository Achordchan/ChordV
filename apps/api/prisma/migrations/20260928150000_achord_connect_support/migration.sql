-- 新工单系统（Achord Connect）：用户全部请求的未读总数。只新增表，不改动旧工单数据。
-- CreateTable
CREATE TABLE "SupportUnreadState" (
    "userId" TEXT NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "sourceAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requestsComplete" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportUnreadState_pkey" PRIMARY KEY ("userId")
);

-- 新工单系统：用户每个请求的未读数。
-- CreateTable
CREATE TABLE "SupportRequestUnread" (
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "unreadCount" INTEGER NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRequestUnread_pkey" PRIMARY KEY ("userId","requestId")
);

-- 已处理的 Webhook 事件 ID，用于去重。
-- CreateTable
CREATE TABLE "AchordConnectWebhookEvent" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AchordConnectWebhookEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "AchordConnectWebhookEvent_receivedAt_idx" ON "AchordConnectWebhookEvent"("receivedAt");

-- AddForeignKey
ALTER TABLE "SupportUnreadState" ADD CONSTRAINT "SupportUnreadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequestUnread" ADD CONSTRAINT "SupportRequestUnread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
