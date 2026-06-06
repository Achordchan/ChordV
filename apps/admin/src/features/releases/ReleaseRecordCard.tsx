import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Paper,
  Stack,
  Text,
  ThemeIcon
} from "@mantine/core";
import { IconCheck, IconCopy, IconEdit, IconExternalLink, IconPlus, IconTrash } from "@tabler/icons-react";
import type { AdminReleaseArtifactRecordDto, AdminReleasePlatform, AdminReleaseRecordDto } from "../../api/client";
import { formatDateTime } from "../../utils/admin-format";
import { StatusBadge } from "../shared/StatusBadge";

type ReleaseRecordCardProps = {
  record: AdminReleaseRecordDto;
  busyAction: "status" | "delete" | "artifact" | null;
  onEditRelease: (record: AdminReleaseRecordDto) => void;
  onCreateArtifact: (releaseId: string, platform: AdminReleasePlatform) => void;
  onPublish: (record: AdminReleaseRecordDto) => void;
  onWithdraw: (record: AdminReleaseRecordDto) => void;
  onDeleteRelease: (record: AdminReleaseRecordDto) => void;
  onCopyDownloadUrl: (url: string) => void;
  onEditArtifact: (releaseId: string, artifact: AdminReleaseArtifactRecordDto) => void;
  onRemoveArtifact: (releaseId: string, artifactId: string) => void;
};

export function ReleaseRecordCard(props: ReleaseRecordCardProps) {
  const { record } = props;
  const isArchived = record.status === "archived";
  const recordBusy = props.busyAction !== null;
  const statusBusy = props.busyAction === "status";
  const deleteBusy = props.busyAction === "delete";
  const publishDisabled = record.artifacts.length === 0 || isArchived;
  const artifactEditingDisabled = record.status !== "draft" || recordBusy;
  const tone =
    record.status === "published"
      ? { color: "green", bg: "rgba(46, 160, 67, 0.05)" }
      : isArchived
        ? { color: "gray", bg: "rgba(134, 142, 150, 0.08)" }
        : { color: "blue", bg: "rgba(34, 139, 230, 0.05)" };

  return (
    <Card withBorder radius="xl" p="lg" style={{ background: tone.bg }}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={6}>
            <Group gap="xs" wrap="wrap">
              <Text fw={700} size="lg">
                {record.version}
              </Text>
              <Badge variant="light">{translatePlatform(record.platform)}</Badge>
              <Badge variant="outline">正式版</Badge>
              <StatusBadge color={releaseStatusColor(record.status)} label={translateReleaseStatus(record.status)} />
            </Group>
            <Text fw={600}>{record.title}</Text>
            <Text size="sm" c="dimmed">
              {record.publishedAt ? `发布时间 ${formatDateTime(record.publishedAt)}` : "尚未发布"}
            </Text>
          </Stack>
          <Group gap="xs" wrap="wrap">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconEdit size={14} />}
              onClick={() => props.onEditRelease(record)}
              disabled={isArchived || recordBusy}
              title={isArchived ? "Archived releases are read-only." : undefined}
            >
              编辑
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => props.onCreateArtifact(record.id, record.platform)}
              disabled={artifactEditingDisabled}
              title={artifactEditingDisabled ? "请先撤回发布，再调整安装包" : undefined}
            >
              新增安装包
            </Button>
            {isArchived ? (
              <Button size="xs" variant="default" disabled>
                Archived
              </Button>
            ) : record.status === "published" ? (
              <Button
                size="xs"
                color="orange"
                variant="light"
                loading={statusBusy}
                disabled={recordBusy && !statusBusy}
                onClick={() => props.onWithdraw(record)}
              >
                撤回发布
              </Button>
            ) : (
              <Button size="xs" loading={statusBusy} disabled={publishDisabled || (recordBusy && !statusBusy)} onClick={() => props.onPublish(record)}>
                发布版本
              </Button>
            )}
            <Button
              size="xs"
              color="red"
              variant="subtle"
              loading={deleteBusy}
              onClick={() => props.onDeleteRelease(record)}
              disabled={isArchived || (recordBusy && !deleteBusy)}
            >
              删除记录
            </Button>
          </Group>
        </Group>

        {record.status === "draft" ? (
          <Alert color="blue" variant="light">
            当前还是草稿。补完至少一个安装包后，再点击“发布版本”。
          </Alert>
        ) : (
          <Alert color="teal" variant="light">
            当前版本已发布。若要新增、编辑或删除安装包，请先执行“撤回发布”。
          </Alert>
        )}

        {record.changelog.length > 0 ? (
          <Stack gap={6}>
            <Text fw={600}>更新日志</Text>
            <List
              spacing="xs"
              icon={
                <ThemeIcon size={18} radius="xl" color={tone.color} variant="light">
                  <IconCheck size={12} />
                </ThemeIcon>
              }
            >
              {record.changelog.map((item) => (
                <List.Item key={`${record.id}:${item}`}>{item}</List.Item>
              ))}
            </List>
          </Stack>
        ) : (
          <Alert color="yellow" variant="light">
            这条发布记录还没有填写更新日志。
          </Alert>
        )}

        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap">
            <Text fw={600}>安装包</Text>
            <Badge variant="light">{record.artifacts.length} 个</Badge>
          </Group>

          {record.artifacts.length === 0 ? (
            <Alert color="yellow" variant="light">
              当前版本还没有安装包，客户端不能直接拿它做更新入口。
            </Alert>
          ) : (
            <Stack gap="sm">
              {record.artifacts.map((artifact) => {
                const downloadUrl = artifact.downloadUrl;

                return (
                  <Paper key={artifact.id} withBorder radius="lg" p="md">
                    <Stack gap="sm">
                      <Group justify="space-between" align="flex-start" wrap="wrap">
                        <Stack gap={4} style={{ flex: 1, minWidth: 260 }}>
                          <Group gap="xs" wrap="wrap">
                            <Badge variant="light">{artifact.source === "uploaded" ? "已上传" : "外部链接"}</Badge>
                            <Badge variant="outline">{translateArtifactType(artifact.type)}</Badge>
                            {artifact.isPrimary ? <Badge color="blue" variant="light">更新入口</Badge> : null}
                          </Group>
                          <Text fw={600}>{artifact.fileName || "未命名安装包"}</Text>
                          <Text size="sm" c="dimmed">
                            下载地址：{downloadUrl}
                          </Text>
                        </Stack>

                        <Stack gap={8} align="flex-end">
                          <Group gap={4} wrap="nowrap">
                            <ActionIcon variant="subtle" onClick={() => props.onCopyDownloadUrl(downloadUrl)} title="复制下载地址">
                              <IconCopy size={16} />
                            </ActionIcon>
                            <ActionIcon
                              component="a"
                              href={downloadUrl}
                              target="_blank"
                              rel="noreferrer"
                              variant="subtle"
                              title="打开下载地址"
                            >
                              <IconExternalLink size={16} />
                            </ActionIcon>
                            <ActionIcon
                              variant="subtle"
                              onClick={() => props.onEditArtifact(record.id, artifact)}
                              title={artifactEditingDisabled ? "请先撤回发布，再编辑安装包" : "编辑安装包"}
                              disabled={artifactEditingDisabled}
                            >
                              <IconEdit size={16} />
                            </ActionIcon>
                            <ActionIcon
                              color="red"
                              variant="subtle"
                              onClick={() => props.onRemoveArtifact(record.id, artifact.id)}
                              title={artifactEditingDisabled ? "请先撤回发布，再删除安装包" : "删除安装包"}
                              disabled={artifactEditingDisabled}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        </Stack>
                      </Group>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

function translatePlatform(platform: AdminReleasePlatform) {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "android") return "Android";
  return "iOS";
}

function translateReleaseStatus(status: AdminReleaseRecordDto["status"]) {
  if (status === "archived") return "Archived";
  if (status === "published") return "已发布";
  return "草稿";
}

function releaseStatusColor(status: AdminReleaseRecordDto["status"]) {
  if (status === "archived") return "gray";
  if (status === "published") return "green";
  return "blue";
}

function translateArtifactType(type: string) {
  switch (type) {
    case "dmg":
      return "DMG";
    case "app":
      return "APP";
    case "exe":
      return "EXE";
    case "setup.exe":
      return "Setup";
    case "zip":
      return "ZIP";
    case "apk":
      return "APK";
    case "ipa":
      return "IPA";
    default:
      return "外部链接";
  }
}
