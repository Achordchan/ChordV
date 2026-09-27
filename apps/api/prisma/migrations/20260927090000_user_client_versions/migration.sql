-- 用户客户端版本：由已登录客户端的检查更新请求记录，每位用户每个平台一条。
-- CreateTable
CREATE TABLE "UserClientVersion" (
    "userId" TEXT NOT NULL,
    "platform" "ReleasePlatform" NOT NULL,
    "version" TEXT NOT NULL,
    "build" INTEGER,
    "channel" "ReleaseChannel" NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserClientVersion_pkey" PRIMARY KEY ("userId","platform")
);

-- CreateIndex
CREATE INDEX "UserClientVersion_lastSeenAt_idx" ON "UserClientVersion"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "UserClientVersion" ADD CONSTRAINT "UserClientVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
