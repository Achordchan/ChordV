import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Select,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArchive, IconCheck, IconCopy, IconEdit, IconExternalLink, IconPlus, IconShieldCheck, IconTrash } from "@tabler/icons-react";
import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseChannel,
  AdminReleaseArtifactValidationDto,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  AdminReleaseStatus,
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto
} from "../api/client";
import {
  createAdminRelease,
  createAdminReleaseArtifact,
  deleteAdminReleaseArtifact,
  fetchAdminRuntimeComponentFailures,
  fetchAdminRuntimeComponents,
  fetchAdminReleases,
  replaceAdminReleaseArtifactUpload,
  uploadAdminReleaseArtifact,
  updateAdminRelease,
  updateAdminReleaseArtifact,
  verifyAdminReleaseArtifact
} from "../api/client";
import { ArtifactEditorModal } from "../features/releases/ArtifactEditorModal";
import { ReleaseEditorModal } from "../features/releases/ReleaseEditorModal";
import { RuntimeComponentsPanel } from "../features/runtime-components/RuntimeComponentsPanel";
import {
  emptyArtifactEditorForm,
  emptyReleaseEditorForm,
  releaseChannelOptions,
  releasePlatformOptions,
  releaseStatusOptions,
  toArtifactEditorForm,
  toReleaseEditorForm,
  type ArtifactEditorFormState,
  type ReleaseEditorFormState
} from "../features/releases/types";
import { DataTable } from "../features/shared/DataTable";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { readError } from "../utils/admin-filters";
import { formatDateTime } from "../utils/admin-format";

type PlatformFilter = AdminReleasePlatform | "all";
type ChannelFilter = AdminReleaseChannel | "all";
type StatusFilter = AdminReleaseStatus | "all";

type ArtifactEditorState = {
  releaseId: string;
  artifactId: string | null;
  platform: AdminReleasePlatform;
};

const platformFilterOptions = [
  { value: "all", label: "全部平台" },
  ...releasePlatformOptions
];

const channelFilterOptions = [
  { value: "all", label: "全部渠道" },
  ...releaseChannelOptions
];

const statusFilterOptions = [
  { value: "all", label: "全部状态" },
  ...releaseStatusOptions
];

export function ReleasesPage() {
  const [activeView, setActiveView] = useState<"app_releases" | "runtime_components">("app_releases");
  const [searchValue, setSearchValue] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [releases, setReleases] = useState<AdminReleaseRecordDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [releaseEditorId, setReleaseEditorId] = useState<string | null>(null);
  const [releaseEditorOpened, setReleaseEditorOpened] = useState(false);
  const [releaseForm, setReleaseForm] = useState<ReleaseEditorFormState>(emptyReleaseEditorForm());
  const [artifactEditor, setArtifactEditor] = useState<ArtifactEditorState | null>(null);
  const [artifactForm, setArtifactForm] = useState<ArtifactEditorFormState>(emptyArtifactEditorForm());
  const [artifactValidation, setArtifactValidation] = useState<Record<string, AdminReleaseArtifactValidationDto>>({});
  const [runtimeComponents, setRuntimeComponents] = useState<AdminRuntimeComponentRecordDto[]>([]);
  const [runtimeFailures, setRuntimeFailures] = useState<AdminRuntimeComponentFailureReportDto[]>([]);
  const [runtimeValidation, setRuntimeValidation] = useState<Record<string, AdminRuntimeComponentValidationDto>>({});

  useEffect(() => {
    void loadReleases();
    void loadRuntimeComponents();
  }, []);

  const filteredReleases = useMemo(
    () =>
      releases.filter((item) => {
        if (platformFilter !== "all" && item.platform !== platformFilter) return false;
        if (channelFilter !== "all" && item.channel !== channelFilter) return false;
        if (statusFilter !== "all" && item.status !== statusFilter) return false;
        if (!searchValue.trim()) return true;
        const normalized = searchValue.trim().toLowerCase();
        return [item.version, item.title, item.releaseNotes ?? "", item.minimumVersion, item.changelog.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      }),
    [channelFilter, platformFilter, releases, searchValue, statusFilter]
  );

  async function loadReleases() {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminReleases();
      setReleases(data);
    } catch (reason) {
      setError(readError(reason, "发布中心接口暂不可用，请先确认后端发布中心接口是否已合并。"));
    } finally {
      setLoading(false);
    }
  }

  async function loadRuntimeComponents() {
    try {
      const [components, failures] = await Promise.all([fetchAdminRuntimeComponents(), fetchAdminRuntimeComponentFailures()]);
      setRuntimeComponents(components);
      setRuntimeFailures(failures);
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "内核组件",
        message: readError(reason, "加载内核组件失败")
      });
    }
  }

  function openCreateRelease() {
    setReleaseEditorId(null);
    setReleaseForm(
      emptyReleaseEditorForm(platformFilter === "all" ? "macos" : platformFilter, channelFilter === "all" ? "stable" : channelFilter)
    );
    setReleaseEditorOpened(true);
  }

  function openEditRelease(record: AdminReleaseRecordDto) {
    setReleaseEditorId(record.id);
    setReleaseForm(toReleaseEditorForm(record));
    setReleaseEditorOpened(true);
  }

  function closeReleaseEditor() {
    setReleaseEditorOpened(false);
    setReleaseEditorId(null);
    setReleaseForm(emptyReleaseEditorForm());
  }

  async function saveRelease() {
    try {
      setSaving(true);
      const payload = {
        platform: releaseForm.platform,
        channel: releaseForm.channel,
        status: releaseForm.status,
        version: releaseForm.version.trim(),
        minimumVersion: releaseForm.minimumVersion.trim(),
        forceUpgrade: releaseForm.forceUpgrade,
        title: releaseForm.title.trim(),
        releaseNotes: releaseForm.releaseNotes.trim() || null,
        changelog: splitLines(releaseForm.changelog)
      };

      const isCreating = !releaseEditorId;
      const record = releaseEditorId ? await updateAdminRelease(releaseEditorId, payload) : await createAdminRelease(payload);
      setReleases((current) => upsertRelease(current, record));
      closeReleaseEditor();
      if (isCreating) {
        openCreateArtifact(record.id, record.platform);
      }
      notifications.show({
        color: "green",
        title: "发布中心",
        message: releaseEditorId ? "发布记录已更新" : "发布记录已创建，请继续补充安装产物"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "发布中心",
        message: readError(reason, "保存发布记录失败")
      });
    } finally {
      setSaving(false);
    }
  }

  async function updateReleaseStatus(record: AdminReleaseRecordDto, nextStatus: AdminReleaseStatus) {
    try {
      setSaving(true);
      const nextRecord = await updateAdminRelease(record.id, {
        status: nextStatus,
        publishedAt: nextStatus === "published" ? new Date().toISOString() : nextStatus === "draft" ? null : record.publishedAt ?? null
      });
      setReleases((current) => upsertRelease(current, nextRecord));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: `已切换为${translateReleaseStatus(nextStatus)}`
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "发布中心",
        message: readError(reason, "更新发布状态失败")
      });
    } finally {
      setSaving(false);
    }
  }

  function openCreateArtifact(releaseId: string, releasePlatform?: AdminReleasePlatform) {
    const release = releases.find((item) => item.id === releaseId);
    const platform = releasePlatform ?? release?.platform ?? "macos";
    setArtifactEditor({ releaseId, artifactId: null, platform });
    setArtifactForm(emptyArtifactEditorForm(defaultArtifactTypeForPlatform(platform)));
  }

  function openEditArtifact(releaseId: string, artifact: AdminReleaseArtifactRecordDto) {
    const release = releases.find((item) => item.id === releaseId);
    setArtifactEditor({ releaseId, artifactId: artifact.id, platform: release?.platform ?? "macos" });
    setArtifactForm(toArtifactEditorForm(artifact));
  }

  function closeArtifactEditor() {
    setArtifactEditor(null);
    setArtifactForm(emptyArtifactEditorForm());
  }

  async function saveArtifact() {
    if (!artifactEditor) return;
    try {
      setSaving(true);
      const isExternal = artifactForm.source === "external" || artifactForm.type === "external";
      let record;
      if (isExternal) {
        const payload = {
          source: "external" as const,
          type: artifactForm.type,
          downloadUrl: artifactForm.downloadUrl.trim(),
          defaultMirrorPrefix: artifactForm.defaultMirrorPrefix.trim() || null,
          allowClientMirror: artifactForm.allowClientMirror,
          fileName: artifactForm.fileName.trim() || null,
          fileSizeBytes: artifactForm.fileSizeBytes === "" ? null : String(artifactForm.fileSizeBytes),
          fileHash: artifactForm.fileHash.trim() || null,
          isPrimary: artifactForm.isPrimary,
          isFullPackage: artifactForm.isFullPackage
        };
        record = artifactEditor.artifactId
          ? await updateAdminReleaseArtifact(artifactEditor.releaseId, artifactEditor.artifactId, payload)
          : await createAdminReleaseArtifact(artifactEditor.releaseId, payload);
      } else {
        if (!artifactForm.selectedFile && !artifactEditor.artifactId) {
          throw new Error("请先选择要上传的安装包文件");
        }
        if (artifactForm.selectedFile) {
          const uploadPayload = {
            source: "uploaded" as const,
            type: artifactForm.type,
            fileName: artifactForm.fileName.trim() || artifactForm.selectedFile.name,
            defaultMirrorPrefix: null,
            allowClientMirror: true,
            isPrimary: artifactForm.isPrimary,
            isFullPackage: artifactForm.isFullPackage
          };
          record = artifactEditor.artifactId
            ? await replaceAdminReleaseArtifactUpload(
                artifactEditor.releaseId,
                artifactEditor.artifactId,
                uploadPayload,
                artifactForm.selectedFile
              )
            : await uploadAdminReleaseArtifact(artifactEditor.releaseId, uploadPayload, artifactForm.selectedFile);
        } else {
          const payload = {
            source: "uploaded" as const,
            type: artifactForm.type,
            fileName: artifactForm.fileName.trim() || null,
            defaultMirrorPrefix: null,
            allowClientMirror: true,
            isPrimary: artifactForm.isPrimary,
            isFullPackage: artifactForm.isFullPackage
          };
          record = await updateAdminReleaseArtifact(artifactEditor.releaseId, artifactEditor.artifactId!, payload);
        }
      }
      setReleases((current) => upsertRelease(current, record));
      closeArtifactEditor();
      notifications.show({
        color: "green",
        title: "发布中心",
        message: artifactEditor.artifactId ? "产物已更新" : "产物已新增"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "发布中心",
        message: readError(reason, "保存产物失败")
      });
    } finally {
      setSaving(false);
    }
  }

  async function removeArtifact(releaseId: string, artifactId: string) {
    if (!window.confirm("确定删除这条产物记录吗？")) return;
    try {
      setSaving(true);
      const record = await deleteAdminReleaseArtifact(releaseId, artifactId);
      setReleases((current) => upsertRelease(current, record));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "产物已删除"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "发布中心",
        message: readError(reason, "删除产物失败")
      });
    } finally {
      setSaving(false);
    }
  }

  async function verifyArtifact(releaseId: string, artifact: AdminReleaseArtifactRecordDto) {
    try {
      const result = await verifyAdminReleaseArtifact(releaseId, artifact.id);
      setArtifactValidation((current) => ({ ...current, [artifact.id]: result }));
      notifications.show({
        color: result.status === "ready" ? "green" : "yellow",
        title: "安装产物校验",
        message: result.message
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "安装产物校验",
        message: readError(reason, "校验安装产物失败")
      });
    }
  }

  async function copyDownloadUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "下载地址已复制"
      });
    } catch {
      notifications.show({
        color: "red",
        title: "发布中心",
        message: "复制失败，请手动复制下载地址"
      });
    }
  }

  return (
    <>
      <SectionCard searchValue={searchValue} onSearchChange={setSearchValue}>
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>发布中心 / 版本发布</Title>
              <Text size="sm" c="dimmed">
                这里拆成两条线：安装包发布负责应用更新，内核组件负责桌面端运行时依赖下载。
              </Text>
            </Stack>
            {activeView === "app_releases" ? (
              <Button leftSection={<IconPlus size={16} />} onClick={openCreateRelease}>
                新建发布
              </Button>
            ) : null}
          </Group>

          <SegmentedControl
            value={activeView}
            onChange={(value) => setActiveView(value as typeof activeView)}
            data={[
              { value: "app_releases", label: "安装包发布" },
              { value: "runtime_components", label: "内核组件" }
            ]}
            fullWidth
          />

          {activeView === "app_releases" ? (
            <>
              <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="sm">
                <SegmentedControl
                  value={platformFilter}
                  onChange={(value) => setPlatformFilter(value as PlatformFilter)}
                  data={platformFilterOptions.map((item) => ({ value: item.value, label: item.label }))}
                  fullWidth
                />
                <SegmentedControl
                  value={channelFilter}
                  onChange={(value) => setChannelFilter(value as ChannelFilter)}
                  data={channelFilterOptions.map((item) => ({ value: item.value, label: item.label }))}
                  fullWidth
                />
                <Select
                  label="状态筛选"
                  value={statusFilter}
                  data={statusFilterOptions as unknown as { value: string; label: string }[]}
                  onChange={(value) => setStatusFilter((value as StatusFilter) || "all")}
                />
              </SimpleGrid>

              <Alert color="blue" variant="light">
                这里负责维护平台、渠道、最低可用版本、强制升级和安装产物。桌面端正式发布物只保留安装器。
              </Alert>

              {error ? (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              ) : null}

              {loading ? (
                <Text c="dimmed">正在加载发布记录…</Text>
              ) : filteredReleases.length === 0 ? (
                <Alert color="gray" variant="light">
                  当前筛选下还没有发布记录，可以先新建一条正式版发布记录，再补充各平台产物。
                </Alert>
              ) : (
                <Stack gap="md">
                  {filteredReleases.map((record) => (
                    <Card key={record.id} withBorder radius="xl" p="lg">
                      <Stack gap="md">
                        <Group justify="space-between" align="flex-start" wrap="wrap">
                          <Stack gap={6}>
                            <Group gap="xs">
                              <Text fw={700} size="lg">
                                {record.version}
                              </Text>
                              <Badge variant="light">{translatePlatform(record.platform)}</Badge>
                              <Badge variant="outline">{translateChannel(record.channel)}</Badge>
                              <StatusBadge color={releaseStatusColor(record.status)} label={translateReleaseStatus(record.status)} />
                            </Group>
                            <Text fw={600}>{record.title}</Text>
                            <Text size="sm" c="dimmed">
                              最低可用版本 {record.minimumVersion} · {translateDeliveryMode(record.deliveryMode)} ·{" "}
                              {record.forceUpgrade ? "强制升级" : "建议升级"}
                              {record.publishedAt ? ` · 发布时间 ${formatDateTime(record.publishedAt)}` : ""}
                            </Text>
                          </Stack>
                          <Group gap="xs" wrap="wrap">
                            <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => openEditRelease(record)}>
                              编辑发布
                            </Button>
                            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => openCreateArtifact(record.id)}>
                              新增产物
                            </Button>
                            <Button
                              size="xs"
                              variant="default"
                              leftSection={<IconArchive size={14} />}
                              loading={saving}
                              onClick={() => updateReleaseStatus(record, nextReleaseStatus(record.status))}
                            >
                              {nextReleaseActionText(record.status)}
                            </Button>
                          </Group>
                        </Group>

                        {record.releaseNotes ? (
                          <Alert color="blue" variant="light">
                            {record.releaseNotes}
                          </Alert>
                        ) : null}

                        {record.changelog.length > 0 ? (
                          <Stack gap={6}>
                            <Text fw={600}>更新日志</Text>
                            <List
                              spacing="xs"
                              icon={
                                <ThemeIcon size={18} radius="xl" color="blue" variant="light">
                                  <IconCheck size={12} />
                                </ThemeIcon>
                              }
                            >
                              {record.changelog.map((item) => (
                                <List.Item key={`${record.id}:${item}`}>{item}</List.Item>
                              ))}
                            </List>
                          </Stack>
                        ) : null}

                        <Stack gap="sm">
                          <Group justify="space-between">
                            <Text fw={600}>产物列表</Text>
                            <Badge variant="light">{record.artifacts.length} 个产物</Badge>
                          </Group>

                          {record.artifacts.length === 0 ? (
                            <Alert color="yellow" variant="light">
                              当前版本还没有挂任何安装产物。用户可能会收到更新提示，但无法自动下载安装器。请先补一个主下载产物。
                            </Alert>
                          ) : (
                            <DataTable>
                              <Table.Thead>
                                <Table.Tr>
                                  <Table.Th>来源</Table.Th>
                                  <Table.Th>类型</Table.Th>
                                  <Table.Th>文件名</Table.Th>
                                  <Table.Th>下载地址</Table.Th>
                                  <Table.Th>加速</Table.Th>
                                  <Table.Th>大小</Table.Th>
                                  <Table.Th>Hash</Table.Th>
                                  <Table.Th>可用性</Table.Th>
                                  <Table.Th>主入口</Table.Th>
                                  <Table.Th>完整包</Table.Th>
                                  <Table.Th>操作</Table.Th>
                                </Table.Tr>
                              </Table.Thead>
                              <Table.Tbody>
                                {record.artifacts.map((artifact) => (
                                  <Table.Tr key={artifact.id}>
                                    <Table.Td>{artifact.source === "uploaded" ? "已上传" : "外链"}</Table.Td>
                                    <Table.Td>{translateArtifactType(artifact.type)}</Table.Td>
                                    <Table.Td>{artifact.fileName || <Text c="dimmed">自动生成</Text>}</Table.Td>
                                    <Table.Td>
                                      <Text size="sm" maw={320} truncate>
                                        {artifact.downloadUrl}
                                      </Text>
                                    </Table.Td>
                                    <Table.Td>
                                      {artifact.source === "external" ? (
                                        <Stack gap={2}>
                                          <Text size="sm">{artifact.defaultMirrorPrefix || "未设置"}</Text>
                                          <Text size="xs" c="dimmed">
                                            {artifact.allowClientMirror ? "允许客户端覆盖" : "仅后台默认加速"}
                                          </Text>
                                        </Stack>
                                      ) : (
                                        <Text c="dimmed">上传产物无需加速</Text>
                                      )}
                                    </Table.Td>
                                    <Table.Td>{formatFileSize(artifact.fileSizeBytes)}</Table.Td>
                                    <Table.Td>{artifact.fileHash ? <Text size="sm">{artifact.fileHash}</Text> : <Text c="dimmed">未填写</Text>}</Table.Td>
                                    <Table.Td>
                                      <StatusBadge
                                        color={artifactValidationColor(artifactValidation[artifact.id]?.status)}
                                        label={artifactValidationLabel(artifactValidation[artifact.id]?.status)}
                                      />
                                    </Table.Td>
                                    <Table.Td>{artifact.isPrimary ? "是" : "否"}</Table.Td>
                                    <Table.Td>{artifact.isFullPackage ? "是" : "否"}</Table.Td>
                                    <Table.Td>
                                      <Group gap={4} wrap="nowrap">
                                        <ActionIcon variant="subtle" onClick={() => void verifyArtifact(record.id, artifact)} title="校验安装包">
                                          <IconShieldCheck size={16} />
                                        </ActionIcon>
                                        <ActionIcon variant="subtle" onClick={() => void copyDownloadUrl(artifact.downloadUrl)} title="复制下载地址">
                                          <IconCopy size={16} />
                                        </ActionIcon>
                                        <ActionIcon
                                          component="a"
                                          href={artifact.downloadUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          variant="subtle"
                                          title="打开下载地址"
                                        >
                                          <IconExternalLink size={16} />
                                        </ActionIcon>
                                        <ActionIcon variant="subtle" onClick={() => openEditArtifact(record.id, artifact)}>
                                          <IconEdit size={16} />
                                        </ActionIcon>
                                        <ActionIcon color="red" variant="subtle" onClick={() => void removeArtifact(record.id, artifact.id)}>
                                          <IconTrash size={16} />
                                        </ActionIcon>
                                      </Group>
                                    </Table.Td>
                                  </Table.Tr>
                                ))}
                              </Table.Tbody>
                            </DataTable>
                          )}
                        </Stack>
                      </Stack>
                    </Card>
                  ))}
                </Stack>
              )}
            </>
          ) : (
            <RuntimeComponentsPanel
              components={runtimeComponents}
              failures={runtimeFailures}
              validations={runtimeValidation}
              loading={loading}
              saving={saving}
              onRefresh={loadRuntimeComponents}
              onComponentsChange={setRuntimeComponents}
              onFailuresChange={setRuntimeFailures}
              onValidationChange={(componentId, next) => setRuntimeValidation((current) => ({ ...current, [componentId]: next }))}
              onSavingChange={setSaving}
            />
          )}
        </Stack>
      </SectionCard>

      <ReleaseEditorModal
        opened={releaseEditorOpened}
        saving={saving}
        title={releaseEditorId ? "编辑发布记录" : "新建发布记录"}
        form={releaseForm}
        onClose={closeReleaseEditor}
        onChange={setReleaseForm}
        onSubmit={() => void saveRelease()}
      />

      <ArtifactEditorModal
        opened={artifactEditor !== null}
        saving={saving}
        platform={artifactEditor?.platform ?? "macos"}
        title={artifactEditor?.artifactId ? "编辑安装产物" : "新增安装产物"}
        form={artifactForm}
        onClose={closeArtifactEditor}
        onChange={setArtifactForm}
        onSubmit={() => void saveArtifact()}
      />
    </>
  );
}

function upsertRelease(current: AdminReleaseRecordDto[], next: AdminReleaseRecordDto) {
  const existing = current.some((item) => item.id === next.id);
  if (!existing) return [next, ...current];
  return current.map((item) => (item.id === next.id ? next : item));
}

function splitLines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nextReleaseStatus(status: AdminReleaseStatus): AdminReleaseStatus {
  if (status === "draft") return "published";
  if (status === "published") return "archived";
  return "draft";
}

function nextReleaseActionText(status: AdminReleaseStatus) {
  if (status === "draft") return "立即发布";
  if (status === "published") return "转为归档";
  return "恢复草稿";
}

function releaseStatusColor(status: AdminReleaseStatus) {
  if (status === "published") return "green";
  if (status === "archived") return "gray";
  return "blue";
}

function translateReleaseStatus(status: AdminReleaseStatus) {
  if (status === "published") return "已发布";
  if (status === "archived") return "已归档";
  return "草稿";
}

function translatePlatform(platform: AdminReleasePlatform) {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "android") return "Android";
  return "iOS";
}

function translateChannel(channel: AdminReleaseChannel) {
  return "正式版";
}

function translateDeliveryMode(mode: string) {
  if (mode === "external_download") return "跳转外部链接";
  if (mode === "apk_download") return "应用内提示 APK 下载";
  if (mode === "none") return "不提供下载";
  return "应用内下载";
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
  if (!value || value <= 0) return "未填写";
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function artifactValidationColor(status?: AdminReleaseArtifactValidationDto["status"]) {
  if (status === "ready") return "green";
  if (status === "metadata_mismatch") return "yellow";
  if (status === "missing_file" || status === "missing_download_url") return "red";
  return "gray";
}

function artifactValidationLabel(status?: AdminReleaseArtifactValidationDto["status"]) {
  if (status === "ready") return "可发布";
  if (status === "metadata_mismatch") return "元信息不一致";
  if (status === "missing_file") return "文件丢失";
  if (status === "missing_download_url") return "链接无效";
  return "待校验";
}

function defaultArtifactTypeForPlatform(platform: AdminReleasePlatform): AdminReleaseArtifactRecordDto["type"] {
  switch (platform) {
    case "windows":
      return "setup.exe";
    case "android":
      return "apk";
    case "ios":
      return "ipa";
    default:
      return "dmg";
  }
}
