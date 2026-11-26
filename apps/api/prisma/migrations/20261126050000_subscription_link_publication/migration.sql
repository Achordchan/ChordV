-- 订阅链接分发记录：分发层（CF KV）里每个已写入的键一行。只新增表。
-- CreateTable
CREATE TABLE "SubscriptionLinkPublication" (
    "tokenHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionLinkPublication_pkey" PRIMARY KEY ("tokenHash")
);
