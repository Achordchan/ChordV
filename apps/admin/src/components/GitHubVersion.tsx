import { Anchor, Stack, Text } from "@mantine/core";
import { isGitHubReleaseRepository } from "@chordv/shared";
import systemVersion from "../../../../SYSTEM_VERSION?raw";

export function GitHubVersion() {
  const repository = String(import.meta.env.VITE_GITHUB_RELEASE_REPOSITORY ?? "").trim();
  const releaseUrl = isGitHubReleaseRepository(repository)
    ? `https://github.com/${repository}/releases` : null;
  return <Stack gap={3}>
    <Text size="xs" c="dimmed">后台 v{systemVersion.trim()}</Text>
    {releaseUrl
      ? <Anchor size="xs" href={releaseUrl} target="_blank" rel="noopener noreferrer">GitHub 版本</Anchor>
      : <Text size="xs" c="dimmed">本地调试</Text>}
  </Stack>;
}
