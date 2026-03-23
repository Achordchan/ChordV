import { useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconEdit, IconExternalLink, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import type {
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentSource,
  AdminRuntimeComponentValidationDto,
  UpdateAdminRuntimeComponentInputDto,
  UploadAdminRuntimeComponentInputDto
} from "../../api/client";
import {
  createAdminRuntimeComponent,
  deleteAdminRuntimeComponent,
  fetchAdminRuntimeComponentFailures,
  replaceAdminRuntimeComponentUpload,
  uploadAdminRuntimeComponent,
  updateAdminRuntimeComponent,
  verifyAdminRuntimeComponent
} from "../../api/client";
import { readError } from "../../utils/admin-filters";
import { formatDateTime } from "../../utils/admin-format";
import { RuntimeComponentEditorModal } from "./RuntimeComponentEditorModal";
import {
  emptyRuntimeComponentEditorForm,
  toRuntimeComponentEditorForm,
  translateRuntimeComponentKind,
  type RuntimeComponentEditorFormState
} from "./types";

type RuntimeComponentsPanelProps = {
  components: AdminRuntimeComponentRecordDto[];
  failures: AdminRuntimeComponentFailureReportDto[];
  validations: Record<string, AdminRuntimeComponentValidationDto>;
  loading: boolean;
  saving: boolean;
  onRefresh: () => Promise<void>;
  onComponentsChange: (next: AdminRuntimeComponentRecordDto[]) => void;
  onFailuresChange: (next: AdminRuntimeComponentFailureReportDto[]) => void;
  onValidationChange: (componentId: string, next: AdminRuntimeComponentValidationDto) => void;
  onSavingChange: (next: boolean) => void;
};

export function RuntimeComponentsPanel(props: RuntimeComponentsPanelProps) {
  const {
    components,
    failures,
    validations,
    loading,
    saving,
    onRefresh,
    onComponentsChange,
    onFailuresChange,
    onValidationChange,
    onSavingChange
  } = props;

  const [editorOpened, setEditorOpened] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuntimeComponentEditorFormState>(emptyRuntimeComponentEditorForm());

  const groupedSummary = useMemo(() => {
    const runtimeCore = components.filter((item) => item.kind === "xray");
    const rulesets = components.filter((item) => item.kind !== "xray");
    return {
      total: components.length,
      enabled: components.filter((item) => item.enabled).length,
      failures: failures.length,
      runtimeCore,
      rulesets
    };
  }, [components, failures.length]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyRuntimeComponentEditorForm());
    setEditorOpened(true);
  }

  function openEdit(record: AdminRuntimeComponentRecordDto) {
    setEditingId(record.id);
    setForm(toRuntimeComponentEditorForm(record));
    setEditorOpened(true);
  }

  function closeEditor() {
    setEditorOpened(false);
    setEditingId(null);
    setForm(emptyRuntimeComponentEditorForm());
  }

  async function saveComponent() {
    try {
      onSavingChange(true);
      const currentRecord = editingId ? components.find((item) => item.id === editingId) ?? null : null;
      let record: AdminRuntimeComponentRecordDto;
      if (form.source === "uploaded") {
        const uploadPayload: UploadAdminRuntimeComponentInputDto = {
          platform: form.platform,
          architecture: form.architecture,
          kind: form.kind,
          fileName: form.fileName.trim() || null,
          expectedHash: form.expectedHash.trim() || null,
          enabled: form.enabled
        };

        if (!editingId) {
          if (!form.selectedFile) {
            throw new Error("请先选择要上传的组件文件");
          }
          record = await uploadAdminRuntimeComponent(uploadPayload, form.selectedFile);
        } else if (form.selectedFile) {
          record = await replaceAdminRuntimeComponentUpload(editingId, uploadPayload, form.selectedFile);
        } else {
          if (!currentRecord || currentRecord.source !== "uploaded") {
            throw new Error("切换为“上传到服务器”时，请先选择要上传的组件文件");
          }
          const updatePayload: UpdateAdminRuntimeComponentInputDto = {
            source: "uploaded" as AdminRuntimeComponentSource,
            fileName: form.fileName.trim(),
            expectedHash: form.expectedHash.trim() || null,
            enabled: form.enabled
          };
          record = await updateAdminRuntimeComponent(editingId, updatePayload);
        }
      } else {
        const payload = {
          platform: form.platform,
          architecture: form.architecture,
          kind: form.kind,
          source: form.source,
          originUrl: form.originUrl.trim(),
          defaultMirrorPrefix: form.defaultMirrorPrefix.trim() || null,
          allowClientMirror: form.allowClientMirror,
          fileName: form.fileName.trim(),
          archiveEntryName: form.archiveEntryName.trim() || null,
          expectedHash: form.expectedHash.trim() || null,
          enabled: form.enabled
        };
        record = editingId
          ? await updateAdminRuntimeComponent(editingId, payload)
          : await createAdminRuntimeComponent(payload);
      }

      onComponentsChange(upsertRuntimeComponent(components, record));
      closeEditor();
      notifications.show({
        color: "green",
        title: "内核组件",
        message: editingId ? "内核组件已更新" : "内核组件已创建"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "内核组件",
        message: readError(reason, "保存内核组件失败")
      });
    } finally {
      onSavingChange(false);
    }
  }

  async function verifyComponent(record: AdminRuntimeComponentRecordDto) {
    try {
      const result = await verifyAdminRuntimeComponent(record.id);
      onValidationChange(record.id, result);
      notifications.show({
        color: result.status === "ready" ? "green" : result.status === "disabled" ? "yellow" : "red",
        title: "内核组件",
        message: result.message
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "内核组件",
        message: readError(reason, "校验下载链接失败")
      });
    }
  }

  async function removeComponent(record: AdminRuntimeComponentRecordDto) {
    try {
      onSavingChange(true);
      await deleteAdminRuntimeComponent(record.id);
      onComponentsChange(components.filter((item) => item.id !== record.id));
      notifications.show({
        color: "green",
        title: "内核组件",
        message: "内核组件已删除"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "内核组件",
        message: readError(reason, "删除内核组件失败")
      });
    } finally {
      onSavingChange(false);
    }
  }

  async function refreshFailures() {
    try {
      const rows = await fetchAdminRuntimeComponentFailures();
      onFailuresChange(rows);
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "内核组件",
        message: readError(reason, "刷新失败上报失败")
      });
    }
  }

  return (
    <Stack gap="lg">
      <RuntimeComponentEditorModal
        opened={editorOpened}
        editing={Boolean(editingId)}
        saving={saving}
        value={form}
        onChange={setForm}
        onClose={closeEditor}
        onSubmit={() => void saveComponent()}
      />

      <Card withBorder radius="xl" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>内核组件</Title>
              <Text size="sm" c="dimmed">
                这里管理桌面端运行时依赖，不和应用安装包混在一起。
              </Text>
            </Stack>
          <Group gap="xs">
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void onRefresh()} loading={loading}>
              刷新
            </Button>
            <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
              新增组件
            </Button>
          </Group>
          </Group>

          <Group gap="md">
            <Badge color="blue" variant="light">
              共 {groupedSummary.total} 条
            </Badge>
            <Badge color="green" variant="light">
              已启用 {groupedSummary.enabled} 条
            </Badge>
            <Badge color={groupedSummary.failures > 0 ? "red" : "gray"} variant="light">
              失败上报 {groupedSummary.failures} 条
            </Badge>
          </Group>

          <Alert color="blue" variant="light">
            安装包更新走“应用版本发布”。这里专门管理 `Xray / GeoIP / GeoSite` 组件，优先推荐直接上传到你自己的服务器，只有特殊情况才使用远程直链。
          </Alert>

          <RuntimeComponentSection
            title="内核主体"
            description="这里只放真正的 Xray 可执行内核，按平台和架构分别准备。"
            records={groupedSummary.runtimeCore}
            validations={validations}
            saving={saving}
            onEdit={openEdit}
            onVerify={(record) => void verifyComponent(record)}
            onRemove={(record) => void removeComponent(record)}
          />

          <RuntimeComponentSection
            title="规则集"
            description="这里放 GeoIP 和 GeoSite 数据文件。规则集现在按全平台通用处理，只需要保留一份。"
            records={groupedSummary.rulesets}
            validations={validations}
            saving={saving}
            onEdit={openEdit}
            onVerify={(record) => void verifyComponent(record)}
            onRemove={(record) => void removeComponent(record)}
          />
        </Stack>
      </Card>

      <Card withBorder radius="xl" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>失败上报</Title>
              <Text size="sm" c="dimmed">
                客户端内核下载失败后，会把失败原因上报到这里，后续可以再接邮件通知。
              </Text>
            </Stack>
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void refreshFailures()}>
              刷新失败上报
            </Button>
          </Group>

          <Stack gap="sm">
            {failures.length === 0 ? (
              <Card withBorder>
                <Text c="dimmed">目前还没有内核组件失败上报。</Text>
              </Card>
            ) : (
              failures.map((item) => (
                <Card key={item.id} withBorder>
                  <Stack gap={4}>
                    <Group justify="space-between" wrap="nowrap">
                      <Title order={5}>{item.componentLabel}</Title>
                      <Badge color="red" variant="light">
                        {item.reason}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {formatDateTime(item.createdAt)} · 版本 {item.appVersion || "未上报"} · 用户 {item.userId || "未登录"}
                    </Text>
                    {item.message ? <Text size="sm">{item.message}</Text> : null}
                    {item.effectiveUrl ? (
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {item.effectiveUrl}
                      </Text>
                    ) : null}
                  </Stack>
                </Card>
              ))
            )}
          </Stack>
        </Stack>
      </Card>
    </Stack>
  );
}

type RuntimeComponentSectionProps = {
  title: string;
  description: string;
  records: AdminRuntimeComponentRecordDto[];
  validations: Record<string, AdminRuntimeComponentValidationDto>;
  saving: boolean;
  onEdit: (record: AdminRuntimeComponentRecordDto) => void;
  onVerify: (record: AdminRuntimeComponentRecordDto) => void;
  onRemove: (record: AdminRuntimeComponentRecordDto) => void;
};

function RuntimeComponentSection(props: RuntimeComponentSectionProps) {
  const { title, description, records, validations, saving, onEdit, onVerify, onRemove } = props;

  return (
    <Stack gap="sm">
      <Stack gap={4}>
        <Group gap="xs">
          <Title order={5}>{title}</Title>
          <Badge variant="light" color="gray">
            {records.length} 条
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      </Stack>

      <ScrollArea>
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>平台</Table.Th>
              <Table.Th>架构</Table.Th>
              <Table.Th>组件</Table.Th>
              <Table.Th>来源</Table.Th>
              <Table.Th>文件信息</Table.Th>
              <Table.Th>下载地址</Table.Th>
              <Table.Th>状态</Table.Th>
              <Table.Th>验证结果</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {records.map((record) => {
              const validation = validations[record.id];
              return (
                <Table.Tr key={record.id}>
                  <Table.Td>{displayRuntimeComponentPlatform(record)}</Table.Td>
                  <Table.Td>{displayRuntimeComponentArchitecture(record)}</Table.Td>
                  <Table.Td>{translateRuntimeComponentKind(record.kind)}</Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Badge color={record.source === "uploaded" ? "teal" : "blue"} variant="light">
                        {record.source === "uploaded" ? "已上传到服务器" : record.source === "github_remote" ? "远程直链（旧）" : "远程直链"}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {record.allowClientMirror ? "允许客户端自定义加速" : "不允许客户端自定义加速"}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Text size="sm" fw={600}>
                        {record.fileName}
                      </Text>
                      <Text size="xs" c="dimmed">
                        大小：{record.fileSizeBytes ? formatBytes(record.fileSizeBytes) : "待校验"}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        Hash：{record.fileHash ? shrinkHash(record.fileHash) : "未记录"}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Text size="sm" lineClamp={1}>
                        {record.finalUrlPreview}
                      </Text>
                      {record.source !== "uploaded" ? (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          默认加速：{record.defaultMirrorPrefix || "未设置"}
                        </Text>
                      ) : null}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={record.enabled ? "green" : "gray"} variant="light">
                      {record.enabled ? "已启用" : "已停用"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Badge color={validationColor(validation?.status)} variant="light">
                        {validation ? translateValidationStatus(validation.status) : "未校验"}
                      </Badge>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {validation?.message ?? "点击校验后会检查最终下载地址是否可用"}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <ActionIcon variant="light" color="blue" onClick={() => onEdit(record)} aria-label="编辑">
                        <IconEdit size={16} />
                      </ActionIcon>
                      <ActionIcon variant="light" color="green" onClick={() => onVerify(record)} aria-label="校验">
                        <IconCheck size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="light"
                        color="gray"
                        onClick={() =>
                          void navigator.clipboard.writeText(record.finalUrlPreview).then(() => {
                            notifications.show({ color: "green", title: "内核组件", message: "最终下载地址已复制" });
                          })
                        }
                        aria-label="复制"
                      >
                        <IconCopy size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="light"
                        color="dark"
                        component="a"
                        href={record.finalUrlPreview}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="打开"
                      >
                        <IconExternalLink size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="light"
                        color="red"
                        onClick={() => onRemove(record)}
                        aria-label="删除"
                        disabled={saving}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {records.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={9}>
                  <Text c="dimmed" ta="center">
                    当前分组还没有组件。
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Stack>
  );
}

function upsertRuntimeComponent(current: AdminRuntimeComponentRecordDto[], next: AdminRuntimeComponentRecordDto) {
  const existing = current.findIndex((item) => item.id === next.id);
  if (existing === -1) {
    return [...current, next].sort(compareRuntimeComponent);
  }
  return current.map((item) => (item.id === next.id ? next : item)).sort(compareRuntimeComponent);
}

function compareRuntimeComponent(a: AdminRuntimeComponentRecordDto, b: AdminRuntimeComponentRecordDto) {
  return `${a.platform}-${a.architecture}-${a.kind}`.localeCompare(`${b.platform}-${b.architecture}-${b.kind}`);
}

function translatePlatform(platform: AdminRuntimeComponentRecordDto["platform"]) {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "android") return "Android";
  return "iOS";
}

function displayRuntimeComponentPlatform(record: AdminRuntimeComponentRecordDto) {
  if (record.kind === "geoip" || record.kind === "geosite") {
    return "通用";
  }
  return translatePlatform(record.platform);
}

function displayRuntimeComponentArchitecture(record: AdminRuntimeComponentRecordDto) {
  if (record.kind === "geoip" || record.kind === "geosite") {
    return "通用";
  }
  return record.architecture.toUpperCase();
}

function validationColor(status?: AdminRuntimeComponentValidationDto["status"]) {
  if (status === "ready") return "green";
  if (status === "disabled") return "yellow";
  if (status === "invalid_url") return "orange";
  if (status === "missing_file" || status === "metadata_mismatch") return "red";
  return "red";
}

function translateValidationStatus(status: AdminRuntimeComponentValidationDto["status"]) {
  if (status === "ready") return "可用";
  if (status === "disabled") return "已停用";
  if (status === "invalid_url") return "链接有误";
  if (status === "missing_file") return "文件丢失";
  if (status === "metadata_mismatch") return "元信息不一致";
  return "链接不可达";
}

function formatBytes(value?: string | null) {
  if (!value) return "待校验";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "待校验";
  const units = ["B", "KB", "MB", "GB"];
  let current = bytes;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[unitIndex]}`;
}

function shrinkHash(value: string) {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}
