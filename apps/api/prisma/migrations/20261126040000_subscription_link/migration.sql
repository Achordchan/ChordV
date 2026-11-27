-- 第三方客户端订阅链接：每位用户一条。只新增表，不改动现有数据。
-- CreateTable
CREATE TABLE "SubscriptionLink" (
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionLink_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionLink_token_key" ON "SubscriptionLink"("token");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionLink_tokenHash_key" ON "SubscriptionLink"("tokenHash");

-- AddForeignKey
ALTER TABLE "SubscriptionLink" ADD CONSTRAINT "SubscriptionLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
