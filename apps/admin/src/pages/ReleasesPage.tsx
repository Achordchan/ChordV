import { useEffect, useMemo, useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Group, SegmentedControl, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseArtifactValidationDto,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto,
  CreateAdminReleaseInputDto
} from "../api/client";
import {
  createAdminRelease,
  createAdminReleaseArtifact,
  deleteAdminRelease,
  deleteAdminReleaseArtifact,
  fetchAdminReleases,
  fetchAdminRuntimeComponentFailures,
  fetchAdminRuntimeComponents,
  publishAdminRelease,
  replaceAdminReleaseArtifactUpload,
  unpublishAdminRelease,
  updateAdminRelease,
  updateAdminReleaseArtifact,
  uploadAdminReleaseArtifact,
  verifyAdminReleaseArtifact
} from "../api/client";
import { ArtifactEditorModal } from "../features/releases/ArtifactEditorModal";
import { ReleaseEditorModal } from "../features/releases/ReleaseEditorModal";
import { ReleaseRecordCard } from "../features/releases/ReleaseRecordCard";
import { RuntimeComponentsPanel } from "../features/runtime-components/RuntimeComponentsPanel";
import {
  emptyArtifactEditorForm,
  emptyReleaseEditorForm,
  releasePlatformOptions,
  toArtifactEditorForm,
  toReleaseEditorForm,
  type ArtifactEditorFormState,
  type ReleaseEditorFormState
} from "../features/releases/types";
import { SectionCard } from "../features/shared/SectionCard";
import { readError } from "../utils/admin-filters";

type PlatformFilter = AdminReleasePlatform | "all";
type StatusFilter = "all" | "draft" | "published";

type ArtifactEditorState = {
  releaseId: string | null;
  artifactId: string | null;
  platform: AdminReleasePlatform;
};

const platformFilterOptions = [{ value: "all", label: "全部平台" }, ...releasePlatformOptions];

const statusFilterOptions = [
  { value: "all", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "published", label: "已发布" }
] as const;

export function ReleasesPage() {
  const [activeView, setActiveView] = useState<"app_releases" | "runtime_components">("app_releases");
  const [searchValue, setSearchValue] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [releases, setReleases] = useState<AdminReleaseRecordDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [releaseEditorId, setReleaseEditorId] = useState<string | null>(null);
  const [releaseEditorOpened, setReleaseEditorOpened] = useState(false);
  const [releaseForm, setReleaseForm] = useState<ReleaseEditorFormState>(emptyReleaseEditorForm());
  const [pendingCreateRelease, setPendingCreateRelease] = useState<CreateAdminReleaseInputDto | null>(null);
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

  const visibleReleases = useMemo(
    () =>
      releases
        .filter((item) => {
          if (platformFilter !== "all" && item.platform !== platformFilter) return false;
          if (statusFilter !== "all" && item.status !== statusFilter) return false;
          if (!searchValue.trim()) return true;
          const normalized = searchValue.trim().toLowerCase();
          return [item.version, item.title, item.minimumVersion, item.changelog.join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(normalized);
        })
        .sort(compareReleaseRecord),
    [platformFilter, releases, searchValue, statusFilter]
  );

  const groupedReleases = useMemo(
    () =>
      releasePlatformOptions
        .map((option) => ({
          platform: option.value,
          label: option.label,
          records: visibleReleases.filter((item) => item.platform === option.value)
        }))
        .filter((group) => group.records.length > 0),
    [visibleReleases]
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
    setPendingCreateRelease(null);
    setReleaseEditorId(null);
    setReleaseForm(emptyReleaseEditorForm(platformFilter === "all" ? "macos" : platformFilter));
    setReleaseEditorOpened(true);
  }

  function openEditRelease(record: AdminReleaseRecordDto) {
    setPendingCreateRelease(null);
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
      const payload: CreateAdminReleaseInputDto = {
        platform: releaseForm.platform,
        status: "draft",
        version: releaseForm.version.trim(),
        minimumVersion: releaseForm.minimumVersion.trim(),
        forceUpgrade: releaseForm.forceUpgrade,
        title: releaseForm.title.trim(),
        changelog: splitLines(releaseForm.changelog)
      };

      if (!releaseEditorId) {
        setPendingCreateRelease(payload);
        setReleaseEditorOpened(false);
        setArtifactEditor({
          releaseId: null,
          artifactId: null,
          platform: payload.platform
        });
        setArtifactForm(emptyArtifactEditorForm(defaultArtifactTypeForPlatform(payload.platform)));
        notifications.show({
          color: "blue",
          title: "发布中心",
          message: "继续补充首个安装产物。只有产物保存成功，这条发布记录才会真正创建。"
        });
        return;
      }

      const record = await updateAdminRelease(releaseEditorId, {
        title: payload.title,
        changelog: payload.changelog,
        minimumVersion: payload.minimumVersion,
        forceUpgrade: payload.forceUpgrade
      });
      setReleases((current) => upsertRelease(current, record));
      closeReleaseEditor();
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "发布记录已更新"
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

  async function publishRelease(record: AdminReleaseRecordDto) {
    if (record.artifacts.length === 0) {
      notifications.show({
        color: "yellow",
        title: "发布中心",
        message: "请先补充至少一个安装产物，再发布这个版本。"
      });
      return;
    }

    await updateReleaseStatus(record, "published");
  }

  async function withdrawRelease(record: AdminReleaseRecordDto) {
    await updateReleaseStatus(record, "draft");
  }

  async function updateReleaseStatus(record: AdminReleaseRecordDto, nextStatus: "draft" | "published") {
    try {
      setSaving(true);
      const nextRecord = nextStatus === "published" ? await publishAdminRelease(record.id) : await unpublishAdminRelease(record.id);
      setReleases((current) => upsertRelease(current, nextRecord));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: nextStatus === "published" ? "版本已发布" : "已撤回到草稿"
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

  async function deleteRelease(record: AdminReleaseRecordDto) {
    const confirmed = window.confirm(`确认删除 ${record.version} 这条发布记录吗？已上传的安装产物也会一起删除。`);
    if (!confirmed) {
      return;
    }

    try {
      setSaving(true);
      await deleteAdminRelease(record.id);
      setReleases((current) => current.filter((item) => item.id !== record.id));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "发布记录已删除"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "发布中心",
        message: readError(reason, "删除发布记录失败")
      });
    } finally {
      setSaving(false);
    }
  }

  function openCreateArtifact(releaseId: string, releasePlatform?: AdminReleasePlatform) {
    setPendingCreateRelease(null);
    const release = releases.find((item) => item.id === releaseId);
    const platform = releasePlatform ?? release?.platform ?? "macos";
    setArtifactEditor({ releaseId, artifactId: null, platform });
    setArtifactForm(emptyArtifactEditorForm(defaultArtifactTypeForPlatform(platform)));
  }

  function openEditArtifact(releaseId: string, artifact: AdminReleaseArtifactRecordDto) {
    setPendingCreateRelease(null);
    const release = releases.find((item) => item.id === releaseId);
    setArtifactEditor({ releaseId, artifactId: artifact.id, platform: release?.platform ?? "macos" });
    setArtifactForm(toArtifactEditorForm(artifact));
  }

  function closeArtifactEditor(options?: { silent?: boolean }) {
    const shouldNotifyDiscard = Boolean(pendingCreateRelease) && !options?.silent;
    setPendingCreateRelease(null);
    setArtifactEditor(null);
    setArtifactForm(emptyArtifactEditorForm());
    if (shouldNotifyDiscard) {
      notifications.show({
        color: "blue",
        title: "发布中心",
        message: "你已取消这次新建发布，系统不会保留空白发布记录。"
      });
    }
  }

  async function saveArtifact() {
    if (!artifactEditor) return;

    let createdReleaseId: string | null = null;
    let createdViaAtomicFlow = false;
    try {
      setSaving(true);
      let releaseId = artifactEditor.releaseId;
      const isExternal = artifactForm.source === "external" || artifactForm.type === "external";
      const externalPayload = isExternal
        ? {
            source: "external" as const,
            type: artifactForm.type,
            downloadUrl: artifactForm.downloadUrl.trim(),
            defaultMirrorPrefix: artifactForm.defaultMirrorPrefix.trim() || null,
            allowClientMirror: artifactForm.allowClientMirror,
            fileName: artifactForm.fileName.trim() || null,
            isPrimary: artifactForm.isPrimary,
            isFullPackage: artifactForm.isFullPackage
          }
        : null;
      let record;

      if (!releaseId) {
        if (!pendingCreateRelease) {
          throw new Error("缺少发布信息，无法保存安装产物");
        }

        if (externalPayload) {
          record = await createAdminRelease({
            ...pendingCreateRelease,
            initialArtifact: externalPayload
          });
          createdReleaseId = record.id;
          createdViaAtomicFlow = true;
        } else {
          const createdRelease = await createAdminRelease(pendingCreateRelease);
          createdReleaseId = createdRelease.id;
          releaseId = createdRelease.id;
        }
      }

      if (!record && externalPayload) {
        record = artifactEditor.artifactId
          ? await updateAdminReleaseArtifact(releaseId!, artifactEditor.artifactId, externalPayload)
          : await createAdminReleaseArtifact(releaseId!, externalPayload);
      }

      if (!record) {
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
            ? await replaceAdminReleaseArtifactUpload(releaseId!, artifactEditor.artifactId, uploadPayload, artifactForm.selectedFile)
            : await uploadAdminReleaseArtifact(releaseId!, uploadPayload, artifactForm.selectedFile);
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
          record = await updateAdminReleaseArtifact(releaseId!, artifactEditor.artifactId!, payload);
        }
      }

      setReleases((current) => upsertRelease(current, record));
      closeArtifactEditor({ silent: true });
      notifications.show({
        color: "green",
        title: "发布中心",
        message:
          artifactEditor.artifactId
            ? "产物已更新"
            : createdReleaseId
              ? "发布记录和首个产物已创建"
              : "产物已新增"
      });
    } catch (reason) {
      if (createdReleaseId && !createdViaAtomicFlow) {
        try {
          await deleteAdminRelease(createdReleaseId);
        } catch (cleanupReason) {
          notifications.show({
            color: "yellow",
            title: "发布中心",
            message: `首个产物保存失败，而且自动清理草稿也失败了：${readError(cleanupReason, "请手动检查是否残留空白草稿")}`
          });
        }
      }
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
      await loadReleases();
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
              <Title order={4}>发布中心</Title>
              <Text size="sm" c="dimmed">
                安装包发布和内核组件分开管理。发布渠道固定为正式版，页面不再展示多渠道筛选。
              </Text>
            </Stack>
            <Group gap="xs">
              {activeView === "app_releases" ? (
                <Button leftSection={<IconPlus size={16} />} onClick={openCreateRelease}>
                  新建发布
                </Button>
              ) : null}
              <Button
                variant="light"
                leftSection={<IconRefresh size={16} />}
                onClick={() => void (activeView === "app_releases" ? loadReleases() : loadRuntimeComponents())}
                loading={loading && activeView === "app_releases"}
              >
                刷新
              </Button>
            </Group>
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
              <Card withBorder radius="xl" p="lg">
                <Stack gap="md">
                  <Group justify="space-between" align="flex-start" wrap="wrap">
                    <Stack gap={4}>
                      <Title order={5}>安装包发布</Title>
                      <Text size="sm" c="dimmed">
                        这里只管理应用安装器。桌面端使用 DMG / Setup，移动端按平台使用 APK / IPA。
                      </Text>
                    </Stack>
                    <Group gap="sm" wrap="wrap">
                      <Badge variant="light">{visibleReleases.length} 条可见记录</Badge>
                      <Badge variant="outline">当前仅正式版</Badge>
                    </Group>
                  </Group>

                  <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
                    <SegmentedControl
                      value={platformFilter}
                      onChange={(value) => setPlatformFilter(value as PlatformFilter)}
                      data={platformFilterOptions.map((item) => ({ value: item.value, label: item.label }))}
                      fullWidth
                    />
                    <SegmentedControl
                      value={statusFilter}
                      onChange={(value) => setStatusFilter(value as StatusFilter)}
                      data={statusFilterOptions.map((item) => ({ value: item.value, label: item.label }))}
                      fullWidth
                    />
                  </SimpleGrid>
                </Stack>
              </Card>

              {error ? (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              ) : null}

              {loading ? (
                <Text c="dimmed">正在加载发布记录…</Text>
              ) : groupedReleases.length === 0 ? (
                <Alert color="gray" variant="light">
                  当前筛选下还没有可见发布记录，可以先新建一条草稿，再继续补充安装产物。
                </Alert>
              ) : (
                <Stack gap="lg">
                  {groupedReleases.map((group) => {
                    const latest = group.records[0];
                    const history = group.records.slice(1);

                    return (
                      <Card key={group.platform} withBorder radius="xl" p="lg">
                        <Stack gap="md">
                          <Group justify="space-between" align="flex-start" wrap="wrap">
                            <Stack gap={4}>
                              <Title order={5}>{group.label}</Title>
                              <Text size="sm" c="dimmed">
                                最新记录默认展开，过往版本统一折叠，避免页面无限变长。
                              </Text>
                            </Stack>
                            <Badge variant="light">{group.records.length} 条记录</Badge>
                          </Group>

                          <ReleaseRecordCard
                            record={latest}
                            saving={saving}
                            artifactValidation={artifactValidation}
                            onEditRelease={openEditRelease}
                            onCreateArtifact={openCreateArtifact}
                            onPublish={(record) => void publishRelease(record)}
                            onWithdraw={(record) => void withdrawRelease(record)}
                            onDeleteRelease={(record) => void deleteRelease(record)}
                            onVerifyArtifact={(releaseId, artifact) => void verifyArtifact(releaseId, artifact)}
                            onCopyDownloadUrl={(url) => void copyDownloadUrl(url)}
                            onEditArtifact={openEditArtifact}
                            onRemoveArtifact={(releaseId, artifactId) => void removeArtifact(releaseId, artifactId)}
                          />

                          {history.length > 0 ? (
                            <Accordion variant="contained" radius="lg">
                              <Accordion.Item value={`${group.platform}-history`}>
                                <Accordion.Control>
                                  <Group justify="space-between" wrap="wrap">
                                    <Text fw={600}>过往版本</Text>
                                    <Badge variant="light">{history.length} 条</Badge>
                                  </Group>
                                </Accordion.Control>
                                <Accordion.Panel>
                                  <Stack gap="md">
                                    {history.map((record) => (
                                      <ReleaseRecordCard
                                        key={record.id}
                                        record={record}
                                        saving={saving}
                                        artifactValidation={artifactValidation}
                                        onEditRelease={openEditRelease}
                                        onCreateArtifact={openCreateArtifact}
                                        onPublish={(item) => void publishRelease(item)}
                                        onWithdraw={(item) => void withdrawRelease(item)}
                                        onDeleteRelease={(item) => void deleteRelease(item)}
                                        onVerifyArtifact={(releaseId, artifact) => void verifyArtifact(releaseId, artifact)}
                                        onCopyDownloadUrl={(url) => void copyDownloadUrl(url)}
                                        onEditArtifact={openEditArtifact}
                                        onRemoveArtifact={(releaseId, artifactId) => void removeArtifact(releaseId, artifactId)}
                                      />
                                    ))}
                                  </Stack>
                                </Accordion.Panel>
                              </Accordion.Item>
                            </Accordion>
                          ) : null}
                        </Stack>
                      </Card>
                    );
                  })}
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
        editing={Boolean(releaseEditorId)}
        saving={saving}
        title={releaseEditorId ? "编辑发布记录" : "新建发布记录"}
        submitLabel={releaseEditorId ? "保存发布记录" : "下一步：配置首个产物"}
        form={releaseForm}
        onClose={closeReleaseEditor}
        onChange={setReleaseForm}
        onSubmit={() => void saveRelease()}
      />

      <ArtifactEditorModal
        opened={artifactEditor !== null}
        saving={saving}
        creatingRelease={Boolean(pendingCreateRelease)}
        platform={artifactEditor?.platform ?? "macos"}
        title={artifactEditor?.artifactId ? "编辑安装产物" : pendingCreateRelease ? "新建发布：首个安装产物" : "新增安装产物"}
        submitLabel={
          artifactEditor?.artifactId
            ? "保存产物"
            : pendingCreateRelease
              ? artifactForm.source === "external" || artifactForm.type === "external"
                ? "创建发布并保存首个产物"
                : "创建发布并上传首个产物"
              : "保存产物"
        }
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

function compareReleaseRecord(left: AdminReleaseRecordDto, right: AdminReleaseRecordDto) {
  const versionDiff = compareSemver(right.version, left.version);
  if (versionDiff !== 0) {
    return versionDiff;
  }

  const rightTime = new Date(right.publishedAt ?? right.updatedAt ?? right.createdAt ?? 0).getTime();
  const leftTime = new Date(left.publishedAt ?? left.updatedAt ?? left.createdAt ?? 0).getTime();
  return rightTime - leftTime;
}

function compareSemver(left: string, right: string) {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function normalizeVersionParts(version: string) {
  return version
    .trim()
    .split(/[.-]/)
    .map((item) => Number.parseInt(item, 10))
    .map((item) => (Number.isFinite(item) ? item : 0));
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
