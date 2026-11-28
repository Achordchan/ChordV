-- AlterEnum
ALTER TYPE "ReleaseChannel" ADD VALUE 'beta';

-- A version number identifies one build per platform, so promoting beta to
-- stable only flips the channel and never collides with a second record.
DROP INDEX "Release_platform_channel_version_key";

-- CreateIndex
CREATE UNIQUE INDEX "Release_platform_version_key" ON "Release"("platform", "version");
