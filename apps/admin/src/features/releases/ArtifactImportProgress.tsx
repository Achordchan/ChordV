import { Progress, Stack, Text } from "@mantine/core";
import type { ArtifactImportProgress as ImportProgress } from "../../api/client";

export function ArtifactImportProgress({ value }: { value: ImportProgress | null }) {
  if (!value) return null;
  const total = value.totalBytes;
  const percent = total && total > 0 ? Math.min(100, value.downloadedBytes / total * 100) : null;
  const format = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return <Stack gap={6} role="status" aria-live="polite">
    <Text size="sm" c="dimmed">{value.stage === "saving" ? "正在校验并保存到本站…" : `已获取 ${format(value.downloadedBytes)}${total ? ` / ${format(total)}` : ""}`}</Text>
    {percent !== null && <Progress value={percent} size="sm" color="teal.9" aria-label="安装包获取进度" />}
  </Stack>;
}
