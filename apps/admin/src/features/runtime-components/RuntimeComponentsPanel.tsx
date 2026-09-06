import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Stack,
  Switch,
  Text,
  Textarea,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconCopy,
  IconDots,
  IconEdit,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconTrash
} from "@tabler/icons-react";
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
  fetchAdminDownloadMirrorConfig,
  fetchAdminRuntimeComponentFailures,
  replaceAdminRuntimeComponentUpload,
  updateAdminDownloadMirrorConfig,
  uploadAdminRuntimeComponent,
  updateAdminRuntimeComponent,
  verifyAdminRuntimeComponent
} from "../../api/client";
import type { AdminDownloadMirrorConfigDto } from "../../api/client";
import {
  buildUncertainMutationMessage,
  isPotentiallyCompletedMutationFailure,
  readError,
  summarizeAdminDiagnosticMessage
} from "../../utils/admin-filters";
import { formatDateTime } from "../../utils/admin-format";
import { applyRuntimeComponentValidationToDelivery, getRuntimeComponentDeliveryState } from "./delivery-state";
import { RuntimeComponentEditorModal } from "./RuntimeComponentEditorModal";
import {
  buildRemoteRuntimeComponentPayload,
  countMirrorPrefixes,
  displayRuntimeComponentTarget,
  emptyRuntimeComponentEditorForm,
  runtimeComponentSlots,
  toRuntimeComponentEditorForm,
  translateRuntimeComponentKind,
  type RuntimeComponentEditorFormState,
  type RuntimeComponentSlotKey
} from "./types";

export const DEFAULT_ADMIN_RUNTIME_COMPONENT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function showRuntimeComponentFailure(reason: unknown, fallback: string, options?: { uncertainMessage?: (message: string) => string }) {
  const message = readError(reason, fallback);
  const uncertain = isPotentiallyCompletedMutationFailure(message);
  notifications.show({
    color: uncertain ? "yellow" : "red",
    title: uncertain ? "客户端组件请求状态不确定" : "客户端组件",
    message: uncertain ? options?.uncertainMessage?.(message) ?? buildUncertainMutationMessage("客户端组件操作") : message
  });
  return { message, uncertain };
}

function showRuntimeComponentValidation(message: string) {
  notifications.show({
    color: "yellow",
    title: "客户端组件",
    message
  });
}

type RuntimeComponentsPanelProps = {
  components: AdminRuntimeComponentRecordDto[];
  failures: AdminRuntimeComponentFailureReportDto[];
  validations: Record<string, AdminRuntimeComponentValidationDto>;
  loading: boolean;
  error: string | null;
  saving: boolean;
  onRefresh: (options?: { silent?: boolean }) => Promise<void>;
  onComponentsChange: Dispatch<SetStateAction<AdminRuntimeComponentRecordDto[]>>;
  onFailuresChange: (next: AdminRuntimeComponentFailureReportDto[]) => void;
  onValidationChange: (componentId: string, next: AdminRuntimeComponentValidationDto | null) => void;
  onSavingChange: (next: boolean) => void;
  onMutationStart?: () => void;
  onMutationCommit?: () => void;
  uploadMaxBytes?: number;
};

export function RuntimeComponentsPanel(props: RuntimeComponentsPanelProps) {
  const {
    components,
    failures,
    validations,
    loading,
    error,
    saving,
    onRefresh,
    onComponentsChange,
    onFailuresChange,
    onValidationChange,
    onSavingChange,
    onMutationStart,
    onMutationCommit,
    uploadMaxBytes = DEFAULT_ADMIN_RUNTIME_COMPONENT_MAX_UPLOAD_BYTES
  } = props;

  const [editorOpened, setEditorOpened] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [failuresRefreshing, setFailuresRefreshing] = useState(false);
  const [form, setForm] = useState<RuntimeComponentEditorFormState>(emptyRuntimeComponentEditorForm());
  const [mirrorConfig, setMirrorConfig] = useState<AdminDownloadMirrorConfigDto | null>(null);
  const [mirrorPrefixDraft, setMirrorPrefixDraft] = useState("");
  const [allowClientMirrorDraft, setAllowClientMirrorDraft] = useState(true);
  const [mirrorSaving, setMirrorSaving] = useState(false);
  const [mirrorLoading, setMirrorLoading] = useState(false);
  const savingRef = useRef(false);
  const verifyingRef = useRef<string | null>(null);
  const failureRefreshSeqRef = useRef(0);
  const deletingRef = useRef<Set<string>>(new Set());

  const slotGroups = useMemo(() => {
    return runtimeComponentSlots.map((slot) => {
      const records = components
        .filter((item) => item.kind === slot.key)
        .slice()
        .sort(compareRuntimeComponent);
      return {
        ...slot,
        records,
        enabledCount: records.filter((item) => item.enabled).length,
        deliverableCount: records.filter((item) => item.clientDeliverable).length
      };
    });
  }, [components]);

  function openCreate(kind: RuntimeComponentSlotKey) {
    if (saving || savingRef.current) {
      return;
    }
    setEditingId(null);
    setForm(emptyRuntimeComponentEditorForm(kind));
    setEditorOpened(true);
  }

  function openEdit(record: AdminRuntimeComponentRecordDto) {
    if (saving || savingRef.current) {
      return;
    }
    setEditingId(record.id);
    setForm(toRuntimeComponentEditorForm(record));
    setEditorOpened(true);
  }

  function forceCloseEditor() {
    setEditorOpened(false);
    setEditingId(null);
    setForm(emptyRuntimeComponentEditorForm());
  }

  function closeEditor() {
    if (saving || savingRef.current) {
      return;
    }
    forceCloseEditor();
  }

  async function saveComponent() {
    if (saving || savingRef.current) {
      return;
    }

    const currentRecord = editingId ? components.find((item) => item.id === editingId) ?? null : null;
    const selectedFile = form.selectedFile;
    if (form.source === "uploaded") {
      if (!editingId && !selectedFile) {
        showRuntimeComponentValidation("请先选择要上传的组件文件");
        return;
      }
      if (selectedFile && selectedFile.size > uploadMaxBytes) {
        showRuntimeComponentValidation(`组件文件不能超过 ${formatBytes(String(uploadMaxBytes))}。`);
        return;
      }
      if (editingId && !selectedFile && (!currentRecord || currentRecord.source !== "uploaded")) {
        showRuntimeComponentValidation("切换为“上传到服务器”时，请先选择要上传的组件文件");
        return;
      }
    } else {
      const originUrl = form.originUrl.trim();
      if (!originUrl) {
        showRuntimeComponentValidation("请填写更新地址");
        return;
      }
      if (!/^https?:\/\//i.test(originUrl)) {
        showRuntimeComponentValidation("更新地址必须是完整的 http/https 地址");
        return;
      }
    }

    savingRef.current = true;
    onMutationStart?.();
    try {
      onSavingChange(true);
      let record: AdminRuntimeComponentRecordDto;
      if (form.source === "uploaded") {
        const uploadPayload: UploadAdminRuntimeComponentInputDto = {
          platform: form.platform,
          architecture: form.architecture,
          kind: form.kind,
          fileName: form.fileName.trim() || null,
          enabled: form.enabled
        };

        if (!editingId) {
          record = await uploadAdminRuntimeComponent(uploadPayload, selectedFile!);
        } else if (selectedFile) {
          record = await replaceAdminRuntimeComponentUpload(editingId, uploadPayload, selectedFile);
        } else {
          const updatePayload: UpdateAdminRuntimeComponentInputDto = {
            source: "uploaded" as AdminRuntimeComponentSource,
            fileName: form.fileName.trim(),
            enabled: form.enabled
          };
          record = await updateAdminRuntimeComponent(editingId, updatePayload);
        }
      } else {
        const payload = buildRemoteRuntimeComponentPayload(form);
        record = editingId ? await updateAdminRuntimeComponent(editingId, payload) : await createAdminRuntimeComponent(payload);
      }

      onMutationCommit?.();
      onValidationChange(record.id, null);
      onComponentsChange((current) => upsertRuntimeComponent(current, record));
      forceCloseEditor();
      notifications.show({
        color: "green",
        title: "客户端组件",
        message: editingId ? "配置已更新" : "配置已添加"
      });
    } catch (reason) {
      const result = showRuntimeComponentFailure(reason, "保存客户端组件失败");
      if (result.uncertain) {
        void onRefresh({ silent: true });
      }
    } finally {
      savingRef.current = false;
      onSavingChange(false);
    }
  }

  async function verifyComponent(record: AdminRuntimeComponentRecordDto) {
    if (verifyingRef.current) {
      return;
    }
    onMutationStart?.();
    verifyingRef.current = record.id;
    try {
      setVerifyingId(record.id);
      const result = await verifyAdminRuntimeComponent(record.id);
      onMutationCommit?.();
      onValidationChange(record.id, result);
      onComponentsChange((current) => upsertRuntimeComponent(current, applyRuntimeComponentValidationToDelivery(record, result)));
      notifications.show({
        color: result.status === "ready" ? "green" : result.status === "disabled" || result.status === "pending_validation" ? "yellow" : "red",
        title: "客户端组件",
        message: summarizeAdminDiagnosticMessage(result.message, "地址检测未通过，请检查更新地址。") ?? "地址检测完成"
      });
      void onRefresh({ silent: true });
    } catch (reason) {
      const result = showRuntimeComponentFailure(reason, "地址检测失败", {
        uncertainMessage: (message) => `${message} 检测状态不确定，请刷新后确认。`
      });
      if (result.uncertain) {
        void onRefresh({ silent: true });
      }
    } finally {
      if (verifyingRef.current === record.id) {
        verifyingRef.current = null;
        setVerifyingId(null);
      }
    }
  }

  async function removeComponent(record: AdminRuntimeComponentRecordDto) {
    if (saving || savingRef.current || deletingRef.current.has(record.id)) {
      return;
    }

    const target = displayRuntimeComponentTarget(record);
    const confirmMessage = record.enabled
      ? `确认删除已启用的 ${translateRuntimeComponentKind(record.kind)}（${target}）吗？`
      : `确认删除 ${translateRuntimeComponentKind(record.kind)}（${target}）吗？`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    deletingRef.current.add(record.id);
    savingRef.current = true;
    onMutationStart?.();
    try {
      onSavingChange(true);
      await deleteAdminRuntimeComponent(record.id);
      onMutationCommit?.();
      onValidationChange(record.id, null);
      onComponentsChange((current) => current.filter((item) => item.id !== record.id));
      notifications.show({
        color: "green",
        title: "客户端组件",
        message: "配置已删除"
      });
    } catch (reason) {
      const result = showRuntimeComponentFailure(reason, "删除客户端组件失败");
      if (result.uncertain) {
        void onRefresh({ silent: true });
      }
    } finally {
      deletingRef.current.delete(record.id);
      savingRef.current = false;
      onSavingChange(false);
    }
  }

  async function refreshFailures() {
    const requestSeq = failureRefreshSeqRef.current + 1;
    failureRefreshSeqRef.current = requestSeq;
    try {
      setFailuresRefreshing(true);
      const rows = await fetchAdminRuntimeComponentFailures();
      if (failureRefreshSeqRef.current !== requestSeq) {
        return;
      }
      onFailuresChange(rows);
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "客户端组件",
        message: readError(reason, "刷新失败上报失败")
      });
    } finally {
      if (failureRefreshSeqRef.current === requestSeq) {
        setFailuresRefreshing(false);
      }
    }
  }

  async function loadMirrorConfig() {
    try {
      setMirrorLoading(true);
      const config = await fetchAdminDownloadMirrorConfig();
      setMirrorConfig(config);
      setMirrorPrefixDraft(config.defaultMirrorPrefix ?? "");
      setAllowClientMirrorDraft(config.allowClientMirror);
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "客户端组件",
        message: readError(reason, "加载加速镜像配置失败")
      });
    } finally {
      setMirrorLoading(false);
    }
  }

  async function saveMirrorConfig() {
    if (mirrorSaving) return;
    try {
      setMirrorSaving(true);
      const config = await updateAdminDownloadMirrorConfig({
        defaultMirrorPrefix: mirrorPrefixDraft.trim() || null,
        allowClientMirror: allowClientMirrorDraft
      });
      setMirrorConfig(config);
      setMirrorPrefixDraft(config.defaultMirrorPrefix ?? "");
      setAllowClientMirrorDraft(config.allowClientMirror);
      notifications.show({
        color: "green",
        title: "客户端组件",
        message: "全局加速镜像已保存"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "客户端组件",
        message: readError(reason, "保存加速镜像配置失败")
      });
    } finally {
      setMirrorSaving(false);
    }
  }

  useEffect(() => {
    void loadMirrorConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack gap="lg">
      <RuntimeComponentEditorModal
        opened={editorOpened}
        editing={Boolean(editingId)}
        saving={saving}
        value={form}
        uploadMaxBytes={uploadMaxBytes}
        onChange={setForm}
        onClose={closeEditor}
        onSubmit={() => void saveComponent()}
      />

      <Card withBorder radius="xl" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>全局加速镜像</Title>
              <Text size="sm" c="dimmed">
                发布中心安装包与客户端组件共用。每行一个前缀，优先走加速，失败再回源地址。
              </Text>
            </Stack>
            <Button onClick={() => void saveMirrorConfig()} loading={mirrorSaving} disabled={mirrorLoading}>
              保存镜像
            </Button>
          </Group>
          <Textarea
            label="加速前缀"
            description="支持 https://mirror.example/ 或带 {url} 的模板。可填多行。"
            autosize
            minRows={3}
            placeholder={"https://ghfast.top/\nhttps://gh-proxy.com/"}
            value={mirrorPrefixDraft}
            onChange={(event) => setMirrorPrefixDraft(event.currentTarget.value)}
            disabled={mirrorLoading || mirrorSaving}
          />
          <Switch
            label="允许客户端自定义镜像"
            description="关闭后客户端只能使用后台全局镜像和源地址。"
            checked={allowClientMirrorDraft}
            onChange={(event) => setAllowClientMirrorDraft(event.currentTarget.checked)}
            disabled={mirrorLoading || mirrorSaving}
          />
          {mirrorConfig?.updatedAt ? (
            <Text size="xs" c="dimmed">
              最近保存 {formatDateTime(mirrorConfig.updatedAt)}
            </Text>
          ) : null}
        </Stack>
      </Card>

      <Card withBorder radius="xl" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>客户端组件</Title>
              <Text size="sm" c="dimmed">
                只管理 Xray / GeoIP / GeoSite 的更新来源。加速镜像在上方全局配置，并与发布中心共用。
              </Text>
            </Stack>
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void onRefresh()} loading={loading}>
              刷新
            </Button>
          </Group>

          {error ? (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          ) : null}

          {loading ? (
            <Alert color="blue" variant="light">
              正在加载客户端组件。
            </Alert>
          ) : null}

          <Stack gap="md">
            {slotGroups.map((slot) => (
              <RuntimeComponentSlotCard
                key={slot.key}
                title={slot.title}
                summary={slot.summary}
                records={slot.records}
                enabledCount={slot.enabledCount}
                deliverableCount={slot.deliverableCount}
                validations={validations}
                saving={saving}
                verifyingId={verifyingId}
                mirrorPrefixCount={countMirrorPrefixes(mirrorPrefixDraft)}
                onAdd={() => openCreate(slot.key)}
                onEdit={openEdit}
                onVerify={(record) => void verifyComponent(record)}
                onRemove={(record) => void removeComponent(record)}
              />
            ))}
          </Stack>
        </Stack>
      </Card>

      <Card withBorder radius="xl" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>下载失败</Title>
              <Text size="sm" c="dimmed">
                客户端拉取失败后会汇总到这里，便于排查地址或镜像问题。
              </Text>
            </Stack>
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={() => void refreshFailures()}
              loading={failuresRefreshing}
            >
              刷新
            </Button>
          </Group>

          {failures.length === 0 ? (
            <Text c="dimmed">暂无失败上报。</Text>
          ) : (
            <Stack gap="sm">
              {failures.map((item) => (
                <Card key={item.id} withBorder radius="md" p="md">
                  <Stack gap={4}>
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600}>{item.componentLabel}</Text>
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
              ))}
            </Stack>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

type RuntimeComponentSlotCardProps = {
  title: string;
  summary: string;
  records: AdminRuntimeComponentRecordDto[];
  enabledCount: number;
  deliverableCount: number;
  validations: Record<string, AdminRuntimeComponentValidationDto>;
  saving: boolean;
  verifyingId: string | null;
  mirrorPrefixCount: number;
  onAdd: () => void;
  onEdit: (record: AdminRuntimeComponentRecordDto) => void;
  onVerify: (record: AdminRuntimeComponentRecordDto) => void;
  onRemove: (record: AdminRuntimeComponentRecordDto) => void;
};

function RuntimeComponentSlotCard(props: RuntimeComponentSlotCardProps) {
  const {
    title,
    summary,
    records,
    enabledCount,
    deliverableCount,
    validations,
    saving,
    verifyingId,
    mirrorPrefixCount,
    onAdd,
    onEdit,
    onVerify,
    onRemove
  } = props;

  return (
    <Card withBorder radius="lg" p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4}>
            <Group gap="xs">
              <Title order={5}>{title}</Title>
              <Badge variant="light" color="gray">
                {records.length} 项
              </Badge>
              <Badge variant="light" color={enabledCount > 0 ? "green" : "gray"}>
                启用 {enabledCount}
              </Badge>
              <Badge variant="light" color={deliverableCount > 0 ? "teal" : "yellow"}>
                可下发 {deliverableCount}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {summary}
            </Text>
          </Stack>
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={onAdd} disabled={saving}>
            添加
          </Button>
        </Group>

        {records.length === 0 ? (
          <Text c="dimmed" size="sm">
            还没有配置。添加后，客户端检查更新时会按这里的地址和镜像拉取。
          </Text>
        ) : (
          <Stack gap="sm">
            {records.map((record) => {
              const deliveryState = getRuntimeComponentDeliveryState(record);
              const validation = validations[record.id];
              const rowIsVerifying = verifyingId === record.id;
              const mirrorCount = mirrorPrefixCount;
              return (
                <Card key={record.id} withBorder radius="md" p="md" bg="var(--mantine-color-body)">
                  <Stack gap="sm">
                    <Group justify="space-between" align="flex-start" wrap="wrap">
                      <Stack gap={4} style={{ flex: 1, minWidth: 240 }}>
                        <Group gap="xs" wrap="wrap">
                          <Text fw={600}>{displayRuntimeComponentTarget(record)}</Text>
                          <Badge color={record.enabled ? "green" : "gray"} variant="light">
                            {record.enabled ? "已启用" : "已停用"}
                          </Badge>
                          <Badge color={record.source === "uploaded" ? "teal" : "blue"} variant="light">
                            {record.source === "uploaded" ? "服务器文件" : "远程更新"}
                          </Badge>
                          <Badge color={deliveryState.color} variant="light">
                            {deliveryState.label}
                          </Badge>
                        </Group>
                        <Text size="sm" lineClamp={2}>
                          {record.source === "uploaded" ? record.finalUrlPreview : record.originUrl || record.finalUrlPreview}
                        </Text>
                        <Group gap="md" wrap="wrap">
                          <Text size="xs" c="dimmed">
                            文件 {record.fileName || "-"}
                          </Text>
                          {record.source !== "uploaded" ? (
                            <Text size="xs" c="dimmed">
                              全局镜像 {mirrorCount > 0 ? `${mirrorCount} 个` : "未配置"}
                            </Text>
                          ) : null}
                          {validation ? (
                            <Text size="xs" c="dimmed">
                              检测 {translateValidationStatus(validation.status)}
                            </Text>
                          ) : null}
                        </Group>
                        <Text size="xs" c="dimmed" lineClamp={2}>
                          {deliveryState.description}
                        </Text>
                      </Stack>

                      <Group gap={6} wrap="nowrap">
                        <ActionIcon
                          variant="light"
                          color="blue"
                          onClick={() => onEdit(record)}
                          title="配置"
                          aria-label="配置"
                          disabled={saving || rowIsVerifying}
                        >
                          <IconEdit size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="light"
                          color="green"
                          onClick={() => onVerify(record)}
                          title="检测地址"
                          aria-label="检测地址"
                          loading={rowIsVerifying}
                          disabled={saving || (verifyingId !== null && verifyingId !== record.id)}
                        >
                          <IconCheck size={16} />
                        </ActionIcon>
                        <Menu withinPortal position="bottom-end" shadow="md">
                          <Menu.Target>
                            <ActionIcon variant="light" color="gray" title="更多" aria-label="更多">
                              <IconDots size={16} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconCopy size={14} />}
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(record.finalUrlPreview)
                                  .then(() => {
                                    notifications.show({ color: "green", title: "客户端组件", message: "下载地址已复制" });
                                  })
                                  .catch(() => {
                                    notifications.show({ color: "yellow", title: "客户端组件", message: "复制失败，请手动复制" });
                                  })
                              }
                            >
                              复制下载地址
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconExternalLink size={14} />}
                              component="a"
                              href={record.finalUrlPreview}
                              target="_blank"
                              rel="noreferrer"
                            >
                              打开下载地址
                            </Menu.Item>
                            <Menu.Item
                              color="red"
                              leftSection={<IconTrash size={14} />}
                              onClick={() => onRemove(record)}
                              disabled={saving || rowIsVerifying}
                            >
                              删除
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Group>
                  </Stack>
                </Card>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Card>
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
  const kindOrder = { xray: 0, geoip: 1, geosite: 2 } as const;
  const kindDiff = kindOrder[a.kind] - kindOrder[b.kind];
  if (kindDiff !== 0) return kindDiff;
  return `${a.platform}-${a.architecture}`.localeCompare(`${b.platform}-${b.architecture}`);
}

function translateValidationStatus(status: AdminRuntimeComponentValidationDto["status"]) {
  if (status === "save_failed") return "保存失败";
  if (status === "unreachable") return "无法访问";
  if (status === "pending_validation") return "检测中";
  if (status === "ready") return "可用";
  if (status === "disabled") return "已停用";
  if (status === "invalid_url") return "链接有误";
  if (status === "missing_file") return "文件丢失";
  if (status === "metadata_mismatch") return "内容异常";
  return "不可达";
}

function formatBytes(value?: string | null) {
  if (!value) return "未知";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
  const units = ["B", "KB", "MB", "GB"];
  let current = bytes;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

