-- 订阅链接分发记录：分发层（CF KV）里每个可能存在的键一行，先登记后写入。只新增表。
-- CreateTable
CREATE TABLE "SubscriptionLinkPublication" (
    "destination" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentHash" TEXT,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionLinkPublication_pkey" PRIMARY KEY ("destination","tokenHash")
);

-- CreateIndex
CREATE INDEX "SubscriptionLinkPublication_userId_idx" ON "SubscriptionLinkPublication"("userId");
