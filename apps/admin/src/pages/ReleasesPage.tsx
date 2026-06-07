import { useEffect, useMemo, useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseArtifactType,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  CreateAdminReleaseInputDto
} from "../api/client";
import {
  createAdminRelease,
  createAdminReleaseArtifact,
  deleteAdminRelease,
  deleteAdminReleaseArtifact,
  fetchAdminReleases,
  publishAdminRelease,
  replaceAdminReleaseArtifactUpload,
  unpublishAdminRelease,
  updateAdminRelease,
  updateAdminReleaseArtifact,
  uploadAdminReleaseArtifact
} from "../api/client";
import { ArtifactEditorModal } from "../features/releases/ArtifactEditorModal";
import { ReleaseEditorModal } from "../features/releases/ReleaseEditorModal";
import { ReleaseRecordCard } from "../features/releases/ReleaseRecordCard";
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
import { isPotentiallyCompletedMutationFailure, readError } from "../utils/admin-filters";

type PlatformFilter = AdminReleasePlatform | "all";

type ArtifactEditorState = {
  releaseId: string | null;
  artifactId: string | null;
  platform: AdminReleasePlatform;
};

const platformFilterOptions = [{ value: "all", label: "全部平台" }, ...releasePlatformOptions];

const RELEASE_VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ADMIN_RELEASE_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function showReleaseRequestFailure(reason: unknown, fallback: string) {
  const message = readError(reason, fallback);
  const uncertain = isPotentiallyCompletedMutationFailure(message);
  notifications.show({
    color: uncertain ? "yellow" : "red",
    title: uncertain ? "发布中心请求状态不确定" : "发布中心",
    message: uncertain ? `${message} 请求可能已被后台保存，请刷新发布列表确认最新状态。` : message
  });
  return { message, uncertain };
}

export function ReleasesPage() {
  const [searchValue, setSearchValue] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [releases, setReleases] = useState<AdminReleaseRecordDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [releaseEditorId, setReleaseEditorId] = useState<string | null>(null);
  const [releaseEditorOpened, setReleaseEditorOpened] = useState(false);
  const [releaseForm, setReleaseForm] = useState<ReleaseEditorFormState>(emptyReleaseEditorForm());
  const [artifactEditor, setArtifactEditor] = useState<ArtifactEditorState | null>(null);
  const [artifactForm, setArtifactForm] = useState<ArtifactEditorFormState>(emptyArtifactEditorForm());

  useEffect(() => {
    void loadReleases();
  }, []);

  const visibleReleases = useMemo(
    () =>
      releases
        .filter((item) => {
          if (platformFilter !== "all" && item.platform !== platformFilter) return false;
          if (!searchValue.trim()) return true;
          const normalized = searchValue.trim().toLowerCase();
          return [item.version, item.title, item.changelog.join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(normalized);
        })
        .sort(compareReleaseRecord),
    [platformFilter, releases, searchValue]
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

  function openCreateRelease() {
    setReleaseEditorId(null);
    setReleaseForm(emptyReleaseEditorForm(platformFilter === "all" ? "windows" : platformFilter));
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
      setSaving("release-editor");
      const version = releaseForm.version.trim();
      const validationMessage = validateReleaseEditorInput(version, releaseEditorId ? undefined : releaseForm, releaseForm.platform);
      if (validationMessage) {
        notifications.show({
          color: "yellow",
          title: "发布记录信息不完整",
          message: validationMessage
        });
        return;
      }
      const payload: CreateAdminReleaseInputDto = {
        platform: releaseForm.platform,
        status: "draft",
        version,
        minimumVersion: version,
        forceUpgrade: false,
        title: releaseForm.title.trim() || version,
        changelog: splitLines(releaseForm.changelog),
        initialArtifact:
          !releaseEditorId && releaseForm.artifactSource === "external"
            ? {
                source: "external",
                type: "external",
                deliveryMode: "external_download",
                downloadUrl: releaseForm.downloadUrl.trim(),
                isPrimary: true
              }
            : undefined
      };

      if (!releaseEditorId) {
        let record = await createAdminRelease(payload);
        if (releaseForm.artifactSource === "uploaded") {
          if (!releaseForm.selectedFile) {
            throw new Error("请先选择要上传的安装包文件");
          }
          try {
            record = await uploadAdminReleaseArtifact(
              record.id,
              {
                source: "uploaded",
                type: defaultArtifactTypeForPlatform(releaseForm.platform),
                fileName: releaseForm.fileName.trim() || releaseForm.selectedFile.name,
                isPrimary: true
              },
              releaseForm.selectedFile
            );
          } catch (uploadError) {
            setReleases((current) => upsertRelease(current, record));
            closeReleaseEditor();
            notifications.show({
              color: "yellow",
              title: "发布记录已创建，安装包上传失败",
              message: `${readError(uploadError, "安装包上传失败")}。请在列表中继续新增安装包，或删除这条草稿。`
            });
            return;
          }
        }
        setReleases((current) => upsertRelease(current, record));
        closeReleaseEditor();
        notifications.show({
          color: "green",
          title: "发布中心",
          message: releaseForm.artifactSource === "uploaded" ? "发布记录和上传安装包已创建" : "发布记录和外链安装包已创建"
        });
        return;
      }

      const record = await updateAdminRelease(releaseEditorId, {
        title: payload.title,
        changelog: payload.changelog
      });
      setReleases((current) => upsertRelease(current, record));
      closeReleaseEditor();
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "发布记录已更新"
      });
    } catch (reason) {
      showReleaseRequestFailure(reason, "保存发布记录失败");
    } finally {
      setSaving(null);
    }
  }

  async function publishRelease(record: AdminReleaseRecordDto) {
    if (record.artifacts.length === 0) {
      notifications.show({
        color: "yellow",
        title: "发布中心",
        message: "请先补充至少一个安装包，再发布这个版本。"
      });
      return;
    }

    if (!window.confirm(`Publish ${record.version}? This immediately changes the client update channel.`)) {
      return;
    }

    await updateReleaseStatus(record, "published");
  }

  async function withdrawRelease(record: AdminReleaseRecordDto) {
    if (!window.confirm(`Withdraw ${record.version} to draft? Clients will stop receiving this release.`)) {
      return;
    }

    await updateReleaseStatus(record, "draft");
  }

  async function updateReleaseStatus(record: AdminReleaseRecordDto, nextStatus: "draft" | "published") {
    try {
      setSaving(`release-status:${record.id}`);
      const nextRecord = nextStatus === "published" ? await publishAdminRelease(record.id) : await unpublishAdminRelease(record.id);
      setReleases((current) => upsertRelease(current, nextRecord));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: nextStatus === "published" ? "版本已发布" : "已撤回到草稿"
      });
    } catch (reason) {
      showReleaseRequestFailure(reason, "更新发布状态失败");
    } finally {
      setSaving(null);
    }
  }

  async function deleteRelease(record: AdminReleaseRecordDto) {
    const confirmed = window.confirm(`确认删除 ${record.version} 这条发布记录吗？已上传的安装包也会一起删除。`);
    if (!confirmed) {
      return;
    }

    try {
      setSaving(`release-delete:${record.id}`);
      await deleteAdminRelease(record.id);
      setReleases((current) => current.filter((item) => item.id !== record.id));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "发布记录已删除"
      });
    } catch (reason) {
      showReleaseRequestFailure(reason, "删除发布记录失败");
    } finally {
      setSaving(null);
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

  function getEditingArtifact() {
    if (!artifactEditor?.artifactId) {
      return null;
    }
    return releases
      .find((item) => item.id === artifactEditor.releaseId)
      ?.artifacts.find((artifact) => artifact.id === artifactEditor.artifactId) ?? null;
  }

  function closeArtifactEditor() {
    setArtifactEditor(null);
    setArtifactForm(emptyArtifactEditorForm());
  }

  function isUploadFileRequired() {
    if (!artifactEditor) {
      return false;
    }
    if (artifactForm.source !== "uploaded" || artifactForm.selectedFile) {
      return false;
    }
    const editingArtifact = getEditingArtifact();
    return !editingArtifact || editingArtifact.source !== "uploaded";
  }

  function validateArtifactEditorInput() {
    if (!artifactEditor) {
      return "缺少发布平台信息，请关闭弹窗后重试。";
    }
    if (isUploadFileRequired()) {
      return "请先选择要上传的安装包文件。";
    }
    if (artifactForm.selectedFile && artifactForm.selectedFile.size > ADMIN_RELEASE_MAX_UPLOAD_BYTES) {
      return `安装包不能超过 ${formatUploadBytes(ADMIN_RELEASE_MAX_UPLOAD_BYTES)}。`;
    }
    if (artifactForm.source === "external" && !artifactForm.downloadUrl.trim()) {
      return "请填写外链下载地址。";
    }
    if (artifactForm.source === "external" && !/^https?:\/\//i.test(artifactForm.downloadUrl.trim())) {
      return "外链下载地址必须是完整的 http/https 地址。";
    }
    if (
      artifactForm.source === "external" &&
      (artifactEditor.platform === "windows" || artifactEditor.platform === "macos") &&
      !/^https:\/\//i.test(artifactForm.downloadUrl.trim())
    ) {
      return "桌面端安装包外链必须使用 HTTPS 地址，否则客户端会拒绝下载。";
    }
    return null;
  }

  async function saveArtifact() {
    if (!artifactEditor) return;

    try {
      let releaseId = artifactEditor.releaseId;
      const validationMessage = validateArtifactEditorInput();
      if (validationMessage) {
        notifications.show({
          color: "yellow",
          title: "安装包信息不完整",
          message: validationMessage
        });
        return;
      }

      setSaving(`artifact:${artifactEditor.releaseId ?? "new"}`);
      let record: AdminReleaseRecordDto | null = null;

      if (!releaseId) {
        throw new Error("缺少发布记录，无法保存安装包");
      }

      if (!record) {
        if (artifactForm.source === "external") {
          const externalPayload = {
            source: "external" as const,
            type: "external" as const,
            deliveryMode: "external_download" as const,
            downloadUrl: artifactForm.downloadUrl.trim(),
            fileName: null,
            isPrimary: artifactForm.isPrimary
          };
          record = artifactEditor.artifactId
            ? await updateAdminReleaseArtifact(releaseId!, artifactEditor.artifactId, externalPayload)
            : await createAdminReleaseArtifact(releaseId!, externalPayload);
        }
        if (!record && artifactForm.source === "uploaded" && !artifactForm.selectedFile && artifactEditor.artifactId) {
          const editingArtifact = getEditingArtifact();
          if (editingArtifact?.source === "uploaded") {
            closeArtifactEditor();
            notifications.show({
              color: "blue",
              title: "发布中心",
              message: "未选择新的安装包文件，原安装包保持不变。"
            });
            return;
          }
        }
        if (!record && artifactForm.selectedFile) {
          const uploadPayload = {
            source: "uploaded" as const,
            type: artifactForm.type,
            fileName: artifactForm.fileName.trim() || artifactForm.selectedFile.name,
            isPrimary: artifactForm.isPrimary
          };
          record = artifactEditor.artifactId
            ? await replaceAdminReleaseArtifactUpload(releaseId!, artifactEditor.artifactId, uploadPayload, artifactForm.selectedFile)
            : await uploadAdminReleaseArtifact(releaseId!, uploadPayload, artifactForm.selectedFile);
        }
      }

      if (!record) {
        throw new Error("安装包没有保存成功，请重新选择文件后再试。");
      }
      setReleases((current) => upsertRelease(current, record));
      closeArtifactEditor();
      notifications.show({
        color: "green",
        title: "发布中心",
        message: artifactEditor.artifactId ? "安装包已更新" : "安装包已新增"
      });
    } catch (reason) {
      showReleaseRequestFailure(reason, "保存安装包失败");
    } finally {
      setSaving(null);
    }
  }

  async function removeArtifact(releaseId: string, artifactId: string) {
    if (!window.confirm("确定删除这个安装包吗？")) return;
    try {
      setSaving(`artifact:${releaseId}`);
      const record = await deleteAdminReleaseArtifact(releaseId, artifactId);
      setReleases((current) => upsertRelease(current, record));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "安装包已删除"
      });
    } catch (reason) {
      showReleaseRequestFailure(reason, "删除安装包失败");
    } finally {
      setSaving(null);
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

  function getReleaseBusyAction(recordId: string) {
    if (saving === `release-status:${recordId}`) return "status" as const;
    if (saving === `release-delete:${recordId}`) return "delete" as const;
    if (saving === `artifact:${recordId}`) return "artifact" as const;
    return null;
  }

  return (
    <>
      <SectionCard searchValue={searchValue} onSearchChange={setSearchValue}>
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Title order={4}>发布中心</Title>
              <Text size="sm" c="dimmed">
                这里只做应用安装包发布：新建版本、填写外链或上传安装包、发布或撤回。
              </Text>
            </Stack>
            <Group gap="xs">
              <Button leftSection={<IconPlus size={16} />} onClick={openCreateRelease}>
                新建发布
              </Button>
              <Button
                variant="light"
                leftSection={<IconRefresh size={16} />}
                onClick={() => void loadReleases()}
                loading={loading}
              >
                刷新
              </Button>
            </Group>
          </Group>

          <Group justify="space-between" wrap="wrap">
            <SegmentedControl
              value={platformFilter}
              onChange={(value) => setPlatformFilter(value as PlatformFilter)}
              data={platformFilterOptions.map((item) => ({ value: item.value, label: item.label }))}
            />
            <Badge variant="light">{visibleReleases.length} 条记录</Badge>
          </Group>

          {error ? (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          ) : null}

          {loading ? (
            <Text c="dimmed">正在加载发布记录…</Text>
          ) : groupedReleases.length === 0 ? (
            <Alert color="gray" variant="light">
              当前筛选下还没有可见发布记录，可以先新建一条草稿，再继续补充安装包。
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
                            busyAction={getReleaseBusyAction(latest.id)}
                            onEditRelease={openEditRelease}
                            onCreateArtifact={openCreateArtifact}
                            onPublish={(record) => void publishRelease(record)}
                            onWithdraw={(record) => void withdrawRelease(record)}
                            onDeleteRelease={(record) => void deleteRelease(record)}
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
                                        busyAction={getReleaseBusyAction(record.id)}
                                        onEditRelease={openEditRelease}
                                        onCreateArtifact={openCreateArtifact}
                                        onPublish={(item) => void publishRelease(item)}
                                        onWithdraw={(item) => void withdrawRelease(item)}
                                        onDeleteRelease={(item) => void deleteRelease(item)}
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
        </Stack>
      </SectionCard>

      <ReleaseEditorModal
        opened={releaseEditorOpened}
        editing={Boolean(releaseEditorId)}
        saving={saving === "release-editor"}
        title={releaseEditorId ? "编辑发布记录" : "新建发布记录"}
        submitLabel={releaseEditorId ? "保存发布记录" : "创建发布"}
        form={releaseForm}
        onClose={closeReleaseEditor}
        onChange={setReleaseForm}
        onSubmit={() => void saveRelease()}
      />

      <ArtifactEditorModal
        opened={artifactEditor !== null}
        saving={saving?.startsWith("artifact:") ?? false}
        creatingRelease={false}
        platform={artifactEditor?.platform ?? "macos"}
        title={artifactEditor?.artifactId ? "编辑安装包" : "新增安装包"}
        submitLabel={artifactEditor?.artifactId ? "保存安装包" : "保存安装包"}
        form={artifactForm}
        uploadMaxBytes={ADMIN_RELEASE_MAX_UPLOAD_BYTES}
        uploadFileRequired={isUploadFileRequired()}
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

function validateReleaseEditorInput(version: string, form?: ReleaseEditorFormState, platform?: AdminReleasePlatform) {
  if (!version) {
    return "请填写版本号，例如 1.1.6。";
  }
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    return "版本号格式不正确，请使用 1.2.3、v1.2.3 或 1.2.3-beta.1 这种 SemVer 格式。";
  }
  if (!form) {
    return null;
  }
  if (form.artifactSource === "uploaded") {
    if (!form.selectedFile) {
      return "请先选择要上传的安装包文件。";
    }
    if (form.selectedFile.size > ADMIN_RELEASE_MAX_UPLOAD_BYTES) {
      return `安装包不能超过 ${formatUploadBytes(ADMIN_RELEASE_MAX_UPLOAD_BYTES)}。`;
    }
    return null;
  }
  const downloadUrl = form.downloadUrl.trim();
  if (!downloadUrl) {
    return "请填写外链下载地址。";
  }
  if (!/^https?:\/\//i.test(downloadUrl)) {
    return "外链下载地址必须是完整的 http/https 地址。";
  }
  if ((platform === "windows" || platform === "macos") && !/^https:\/\//i.test(downloadUrl)) {
    return "桌面端安装包外链必须使用 HTTPS 地址。";
  }
  return null;
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

function formatUploadBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  }
  return `${value} B`;
}

function defaultArtifactTypeForPlatform(platform: AdminReleasePlatform): AdminReleaseArtifactType {
  if (platform === "windows") {
    return "zip";
  }
  if (platform === "android") {
    return "apk";
  }
  if (platform === "ios") {
    return "ipa";
  }
  return "dmg";
}
