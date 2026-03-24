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
import { IconCheck, IconCopy, IconEdit, IconExternalLink, IconPlus, IconShieldCheck, IconTrash } from "@tabler/icons-react";
import type { AdminReleaseArtifactRecordDto, AdminReleaseArtifactValidationDto, AdminReleasePlatform, AdminReleaseRecordDto } from "../../api/client";
import { formatDateTime } from "../../utils/admin-format";
import { StatusBadge } from "../shared/StatusBadge";

type ReleaseRecordCardProps = {
  record: AdminReleaseRecordDto;
  saving: boolean;
  artifactValidation: Record<string, AdminReleaseArtifactValidationDto>;
  onEditRelease: (record: AdminReleaseRecordDto) => void;
  onCreateArtifact: (releaseId: string, platform: AdminReleasePlatform) => void;
  onPublish: (record: AdminReleaseRecordDto) => void;
  onWithdraw: (record: AdminReleaseRecordDto) => void;
  onDeleteRelease: (record: AdminReleaseRecordDto) => void;
  onVerifyArtifact: (releaseId: string, artifact: AdminReleaseArtifactRecordDto) => void;
  onCopyDownloadUrl: (url: string) => void;
  onEditArtifact: (releaseId: string, artifact: AdminReleaseArtifactRecordDto) => void;
  onRemoveArtifact: (releaseId: string, artifactId: string) => void;
};

export function ReleaseRecordCard(props: ReleaseRecordCardProps) {
  const { record } = props;
  const publishDisabled = record.artifacts.length === 0;
  const artifactEditingDisabled = record.status === "published";
  const tone = record.status === "published" ? { color: "green", bg: "rgba(46, 160, 67, 0.05)" } : { color: "blue", bg: "rgba(34, 139, 230, 0.05)" };

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
              最低可用版本 {record.minimumVersion} · {translateDeliveryMode(record.deliveryMode)} · {record.forceUpgrade ? "强制升级" : "建议升级"}
              {record.publishedAt ? ` · 发布时间 ${formatDateTime(record.publishedAt)}` : " · 尚未发布"}
            </Text>
          </Stack>
          <Group gap="xs" wrap="wrap">
            <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => props.onEditRelease(record)}>
              编辑发布
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => props.onCreateArtifact(record.id, record.platform)}
              disabled={artifactEditingDisabled}
              title={artifactEditingDisabled ? "请先撤回发布，再调整安装产物" : undefined}
            >
              新增产物
            </Button>
            {record.status === "published" ? (
              <Button size="xs" color="orange" variant="light" loading={props.saving} onClick={() => props.onWithdraw(record)}>
                撤回发布
              </Button>
            ) : (
              <Button size="xs" loading={props.saving} disabled={publishDisabled} onClick={() => props.onPublish(record)}>
                发布版本
              </Button>
            )}
            <Button size="xs" color="red" variant="subtle" onClick={() => props.onDeleteRelease(record)}>
              删除记录
            </Button>
          </Group>
        </Group>

        {record.status === "draft" ? (
          <Alert color="blue" variant="light">
            当前还是草稿。补完至少一个安装产物后，再点击“发布版本”。
          </Alert>
        ) : (
          <Alert color="teal" variant="light">
            当前版本已发布。若要新增、编辑或删除安装产物，请先执行“撤回发布”。
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
            <Text fw={600}>安装产物</Text>
            <Badge variant="light">{record.artifacts.length} 个</Badge>
          </Group>

          {record.artifacts.length === 0 ? (
            <Alert color="yellow" variant="light">
              当前版本还没有挂任何安装产物，客户端不能直接拿它做更新入口。
            </Alert>
          ) : (
            <Stack gap="sm">
              {record.artifacts.map((artifact) => {
                const validation = props.artifactValidation[artifact.id];
                const effectiveUrl = artifact.finalUrlPreview?.trim() || artifact.downloadUrl;
                const previewUrl = artifact.finalUrlPreview?.trim() || buildPreviewDownloadUrl(artifact);
                const originUrl = artifact.originDownloadUrl?.trim() || artifact.downloadUrl;
                const showPreview = Boolean(previewUrl && previewUrl !== originUrl);

                return (
                  <Paper key={artifact.id} withBorder radius="lg" p="md">
                    <Stack gap="sm">
                      <Group justify="space-between" align="flex-start" wrap="wrap">
                        <Stack gap={4} style={{ flex: 1, minWidth: 260 }}>
                          <Group gap="xs" wrap="wrap">
                            <Badge variant="light">{artifact.source === "uploaded" ? "已上传" : "外部链接"}</Badge>
                            <Badge variant="outline">{translateArtifactType(artifact.type)}</Badge>
                            {artifact.isPrimary ? <Badge color="blue" variant="light">客户端更新入口</Badge> : null}
                            {artifact.isFullPackage ? <Badge color="gray" variant="light">完整安装包</Badge> : null}
                          </Group>
                          <Text fw={600}>{artifact.fileName || "未命名产物"}</Text>
                          <Text size="sm" c="dimmed">
                            下载地址：{effectiveUrl}
                          </Text>
                          {showPreview ? (
                            <Text size="sm" c="dimmed">
                              原始地址：{originUrl}
                            </Text>
                          ) : null}
                        </Stack>

                        <Stack gap={8} align="flex-end">
                          <StatusBadge color={artifactValidationColor(validation?.status)} label={artifactValidationLabel(validation?.status)} />
                          <Group gap={4} wrap="nowrap">
                            <ActionIcon variant="subtle" onClick={() => props.onVerifyArtifact(record.id, artifact)} title="校验安装包">
                              <IconShieldCheck size={16} />
                            </ActionIcon>
                            <ActionIcon variant="subtle" onClick={() => props.onCopyDownloadUrl(effectiveUrl)} title="复制下载地址">
                              <IconCopy size={16} />
                            </ActionIcon>
                            <ActionIcon
                              component="a"
                              href={effectiveUrl}
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
                              title={artifactEditingDisabled ? "请先撤回发布，再编辑产物" : "编辑产物"}
                              disabled={artifactEditingDisabled}
                            >
                              <IconEdit size={16} />
                            </ActionIcon>
                            <ActionIcon
                              color="red"
                              variant="subtle"
                              onClick={() => props.onRemoveArtifact(record.id, artifact.id)}
                              title={artifactEditingDisabled ? "请先撤回发布，再删除产物" : "删除产物"}
                              disabled={artifactEditingDisabled}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        </Stack>
                      </Group>

                      <Group gap="md" wrap="wrap">
                        {artifact.fileSizeBytes ? (
                          <Text size="sm" c="dimmed">
                            文件大小：{formatFileSize(artifact.fileSizeBytes)}
                          </Text>
                        ) : (
                          <Text size="sm" c="dimmed">
                            文件大小：未自动识别
                          </Text>
                        )}
                        {artifact.fileHash ? (
                          <Text size="sm" c="dimmed">
                            文件 Hash：{artifact.fileHash}
                          </Text>
                        ) : (
                          <Text size="sm" c="dimmed">
                            文件 Hash：未自动识别
                          </Text>
                        )}
                        {artifact.source === "external" ? (
                          <Text size="sm" c="dimmed">
                            {artifact.allowClientMirror ? "允许客户端覆盖默认加速前缀" : "仅使用后台默认加速前缀"}
                          </Text>
                        ) : null}
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

function translateDeliveryMode(mode: string) {
  if (mode === "external_download") return "跳转外部链接";
  if (mode === "apk_download") return "应用内提示 APK 下载";
  if (mode === "none") return "不提供下载";
  return "应用内下载";
}

function translateReleaseStatus(status: AdminReleaseRecordDto["status"]) {
  if (status === "published") return "已发布";
  return "草稿";
}

function releaseStatusColor(status: AdminReleaseRecordDto["status"]) {
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
    case "apk":
      return "APK";
    case "ipa":
      return "IPA";
    default:
      return "外部链接";
  }
}

function formatFileSize(value?: number | null) {
  if (!value || value <= 0) return "未识别";
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function artifactValidationColor(status?: AdminReleaseArtifactValidationDto["status"]) {
  if (status === "ready") return "green";
  if (status === "metadata_mismatch") return "yellow";
  if (status === "missing_file" || status === "missing_download_url" || status === "invalid_link") return "red";
  return "gray";
}

function artifactValidationLabel(status?: AdminReleaseArtifactValidationDto["status"]) {
  if (status === "ready") return "可发布";
  if (status === "metadata_mismatch") return "元信息不一致";
  if (status === "missing_file") return "文件丢失";
  if (status === "missing_download_url") return "链接缺失";
  if (status === "invalid_link") return "链接无效";
  return "待校验";
}

function buildPreviewDownloadUrl(artifact: AdminReleaseArtifactRecordDto) {
  const prefix = artifact.defaultMirrorPrefix?.trim();
  if (!prefix || artifact.source !== "external") {
    return null;
  }
  if (prefix.includes("{url}")) {
    return prefix.replaceAll("{url}", artifact.downloadUrl);
  }
  return `${prefix}${artifact.downloadUrl}`;
}
