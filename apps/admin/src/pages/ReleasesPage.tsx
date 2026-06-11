import { useEffect, useMemo, useRef, useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseArtifactType,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  CreateAdminReleaseInputDto,
  UploadAdminReleaseArtifactInputDto
} from "../api/client";
import {
  createAdminRelease,
  createAdminReleaseArtifact,
  deleteAdminRelease,
  deleteAdminReleaseArtifact,
  fetchAdminUploadLimits,
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
import { buildUncertainMutationMessage, isPotentiallyCompletedMutationFailure, readError } from "../utils/admin-filters";

type PlatformFilter = AdminReleasePlatform | "all";

type ArtifactEditorState = {
  releaseId: string | null;
  artifactId: string | null;
  platform: AdminReleasePlatform;
};

type ReleasesPageProps = {
  refreshSignal?: number;
};

const platformFilterOptions = [{ value: "all", label: "全部平台" }, ...releasePlatformOptions];

const RELEASE_VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DEFAULT_ADMIN_RELEASE_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function showReleaseRequestFailure(reason: unknown, fallback: string) {
  const message = readError(reason, fallback);
  const uncertain = isPotentiallyCompletedMutationFailure(message);
  notifications.show({
    color: uncertain ? "yellow" : "red",
    title: uncertain ? "发布中心请求状态不确定" : "发布中心",
    message: uncertain ? buildUncertainMutationMessage("发布中心操作") : message
  });
  return { message, uncertain };
}

export function ReleasesPage(props: ReleasesPageProps) {
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
  const [uploadMaxBytes, setUploadMaxBytes] = useState(DEFAULT_ADMIN_RELEASE_MAX_UPLOAD_BYTES);
  const releaseListRequestSeqRef = useRef(0);
  const releaseListLoadingSeqRef = useRef<number | null>(null);
  const releaseMutationSeqRef = useRef(0);
  const savingRef = useRef<string | null>(null);

  useEffect(() => {
    void loadReleases();
    void loadUploadLimits();
  }, []);

  useEffect(() => {
    if (!props.refreshSignal) {
      return;
    }
    void loadReleases({ silent: true });
  }, [props.refreshSignal]);

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

  async function loadUploadLimits() {
    try {
      const limits = await fetchAdminUploadLimits();
      setUploadMaxBytes(limits.releaseArtifactMaxBytes || DEFAULT_ADMIN_RELEASE_MAX_UPLOAD_BYTES);
    } catch {
      setUploadMaxBytes(DEFAULT_ADMIN_RELEASE_MAX_UPLOAD_BYTES);
    }
  }

  async function loadReleases(options?: { silent?: boolean }) {
    const silent = Boolean(options?.silent);
    const requestSeq = ++releaseListRequestSeqRef.current;
    const mutationSeqAtStart = releaseMutationSeqRef.current;
    try {
      if (!silent) {
        releaseListLoadingSeqRef.current = requestSeq;
        setLoading(true);
        setError(null);
      }
      const data = await fetchAdminReleases();
      if (requestSeq !== releaseListRequestSeqRef.current || mutationSeqAtStart !== releaseMutationSeqRef.current) {
        return;
      }
      setReleases(data);
    } catch (reason) {
      if (requestSeq !== releaseListRequestSeqRef.current || mutationSeqAtStart !== releaseMutationSeqRef.current) {
        return;
      }
      if (!silent) {
        setError(readError(reason, "发布中心加载失败，请检查后台服务或稍后重试。"));
      }
    } finally {
      if (!silent && releaseListLoadingSeqRef.current === requestSeq) {
        releaseListLoadingSeqRef.current = null;
        setLoading(false);
      }
    }
  }

  function beginSaving(actionKey: string) {
    if (savingRef.current) {
      return false;
    }
    savingRef.current = actionKey;
    setSaving(actionKey);
    return true;
  }

  function endSaving(actionKey: string) {
    if (savingRef.current !== actionKey) {
      return;
    }
    savingRef.current = null;
    setSaving(null);
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

  function forceCloseReleaseEditor() {
    setReleaseEditorOpened(false);
    setReleaseEditorId(null);
    setReleaseForm(emptyReleaseEditorForm());
  }

  function closeReleaseEditor() {
    if (savingRef.current) {
      return;
    }
    forceCloseReleaseEditor();
  }

  function openArtifactFromReleaseEditor(source: ReleaseEditorFormState["artifactSource"]) {
    if (!releaseEditorId) {
      return;
    }
    const record = releases.find((item) => item.id === releaseEditorId);
    if (!record) {
      return;
    }
    forceCloseReleaseEditor();
    openCreateArtifact(record.id, record.platform, source);
  }

  function isReleaseEditorArtifactEditingDisabled() {
    if (!releaseEditorId) {
      return false;
    }
    const record = releases.find((item) => item.id === releaseEditorId);
    return !record || record.status !== "draft" || getReleaseBusyAction(record.id) !== null;
  }

  async function saveRelease() {
    const actionKey = "release-editor";
    if (!beginSaving(actionKey)) {
      return;
    }
    try {
      const version = releaseForm.version.trim();
      const validationMessage = validateReleaseEditorInput(
        version,
        releaseEditorId ? undefined : releaseForm,
        releaseForm.platform,
        uploadMaxBytes
      );
      if (validationMessage) {
        notifications.show({
          color: "yellow",
          title: "发布记录信息不完整",
          message: validationMessage
        });
        return;
      }
      releaseMutationSeqRef.current += 1;
      const payload: CreateAdminReleaseInputDto = {
        platform: releaseForm.platform,
        status: "draft",
        version,
        minimumVersion: version,
        forceUpgrade: false,
        title: releaseForm.title.trim() || version,
        changelog: splitLines(releaseForm.changelog),
        initialArtifact:
          !releaseEditorId && releaseForm.artifactSource === "external" && releaseForm.downloadUrl.trim()
            ? buildExternalArtifactPayload(releaseForm.platform, releaseForm.downloadUrl, true)
            : undefined
      };

      if (!releaseEditorId) {
        let record = await createAdminRelease(payload);
        if (releaseForm.artifactSource === "uploaded" && releaseForm.selectedFile) {
          try {
            record = await uploadAdminReleaseArtifact(
              record.id,
              buildUploadedArtifactPayload(releaseForm.platform, releaseForm.selectedFile, releaseForm.fileName, true),
              releaseForm.selectedFile
            );
          } catch (uploadError) {
            const result = showReleaseRequestFailure(uploadError, "安装包上传失败");
            if (result.uncertain) {
              void loadReleases();
            } else {
              setReleases((current) => upsertRelease(current, record));
              notifications.show({
                color: "yellow",
                title: "发布记录已创建，安装包上传失败",
                message: `${result.message}。请在列表中继续新增安装包，或删除这条草稿。`
              });
            }
            forceCloseReleaseEditor();
            return;
          }
        }
        setReleases((current) => upsertRelease(current, record));
        forceCloseReleaseEditor();
        notifications.show({
          color: "green",
          title: "发布中心",
          message: releaseFormHasArtifact(releaseForm) ? "发布记录和安装包已创建" : "发布记录已创建，可继续添加外链或上传文件"
        });
        return;
      }

      const record = await updateAdminRelease(releaseEditorId, {
        title: payload.title,
        changelog: payload.changelog
      });
      setReleases((current) => upsertRelease(current, record));
      forceCloseReleaseEditor();
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "发布记录已更新"
      });
    } catch (reason) {
      const result = showReleaseRequestFailure(reason, "保存发布记录失败");
      if (result.uncertain) {
        forceCloseReleaseEditor();
        void loadReleases();
      }
    } finally {
      endSaving(actionKey);
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

    if (!window.confirm(`确认发布 ${record.version} 吗？客户端会开始收到这个版本更新。`)) {
      return;
    }

    await updateReleaseStatus(record, "published");
  }

  async function withdrawRelease(record: AdminReleaseRecordDto) {
    if (!window.confirm(`确认将 ${record.version} 撤回为草稿吗？客户端将不再收到这个版本。`)) {
      return;
    }

    await updateReleaseStatus(record, "draft");
  }

  async function updateReleaseStatus(record: AdminReleaseRecordDto, nextStatus: "draft" | "published") {
    const actionKey = `release-status:${record.id}`;
    if (!beginSaving(actionKey)) {
      return;
    }
    try {
      releaseMutationSeqRef.current += 1;
      const nextRecord = nextStatus === "published" ? await publishAdminRelease(record.id) : await unpublishAdminRelease(record.id);
      setReleases((current) => upsertRelease(current, nextRecord));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: nextStatus === "published" ? "版本已发布" : "已撤回到草稿"
      });
    } catch (reason) {
      const result = showReleaseRequestFailure(reason, "更新发布状态失败");
      if (result.uncertain) {
        void loadReleases();
      }
    } finally {
      endSaving(actionKey);
    }
  }

  async function deleteRelease(record: AdminReleaseRecordDto) {
    const actionKey = `release-delete:${record.id}`;
    if (savingRef.current) {
      return;
    }
    const confirmed = window.confirm(`确认删除 ${record.version} 这条发布记录吗？已上传的安装包也会一起删除。`);
    if (!confirmed) {
      return;
    }

    if (!beginSaving(actionKey)) {
      return;
    }
    try {
      releaseMutationSeqRef.current += 1;
      await deleteAdminRelease(record.id);
      setReleases((current) => current.filter((item) => item.id !== record.id));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "发布记录已删除"
      });
    } catch (reason) {
      const result = showReleaseRequestFailure(reason, "删除发布记录失败");
      if (result.uncertain) {
        void loadReleases();
      }
    } finally {
      endSaving(actionKey);
    }
  }

  function openCreateArtifact(
    releaseId: string,
    releasePlatform?: AdminReleasePlatform,
    source: ArtifactEditorFormState["source"] = "external"
  ) {
    const release = releases.find((item) => item.id === releaseId);
    const platform = releasePlatform ?? release?.platform ?? "macos";
    setArtifactEditor({ releaseId, artifactId: null, platform });
    setArtifactForm(emptyArtifactEditorForm(defaultArtifactTypeForPlatform(platform), source));
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

  function forceCloseArtifactEditor() {
    setArtifactEditor(null);
    setArtifactForm(emptyArtifactEditorForm());
  }

  function closeArtifactEditor() {
    if (savingRef.current) {
      return;
    }
    forceCloseArtifactEditor();
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
    if (artifactForm.selectedFile && artifactForm.selectedFile.size > uploadMaxBytes) {
      return `安装包不能超过 ${formatUploadBytes(uploadMaxBytes)}。`;
    }
    if (artifactForm.selectedFile) {
      const fileMessage = validateReleaseArtifactFile(artifactEditor.platform, artifactForm.selectedFile);
      if (fileMessage) return fileMessage;
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

    const actionKey = `artifact:${artifactEditor.releaseId ?? "new"}`;
    if (!beginSaving(actionKey)) {
      return;
    }
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

      releaseMutationSeqRef.current += 1;
      let record: AdminReleaseRecordDto | null = null;

      if (!releaseId) {
        throw new Error("缺少发布记录，无法保存安装包");
      }

      if (!record) {
        if (artifactForm.source === "external") {
          const externalPayload = buildExternalArtifactPayload(
            artifactEditor.platform,
            artifactForm.downloadUrl,
            artifactForm.isPrimary
          );
          record = artifactEditor.artifactId
            ? await updateAdminReleaseArtifact(releaseId!, artifactEditor.artifactId, externalPayload)
            : await createAdminReleaseArtifact(releaseId!, externalPayload);
        }
        if (!record && artifactForm.source === "uploaded" && !artifactForm.selectedFile && artifactEditor.artifactId) {
          const editingArtifact = getEditingArtifact();
          if (editingArtifact?.source === "uploaded") {
            forceCloseArtifactEditor();
            notifications.show({
              color: "blue",
              title: "发布中心",
              message: "未选择新的安装包文件，原安装包保持不变。"
            });
            return;
          }
        }
        if (!record && artifactForm.selectedFile) {
          const uploadPayload = buildUploadedArtifactPayload(
            artifactEditor.platform,
            artifactForm.selectedFile,
            artifactForm.fileName,
            artifactForm.isPrimary,
            artifactForm.type
          );
          record = artifactEditor.artifactId
            ? await replaceAdminReleaseArtifactUpload(releaseId!, artifactEditor.artifactId, uploadPayload, artifactForm.selectedFile)
            : await uploadAdminReleaseArtifact(releaseId!, uploadPayload, artifactForm.selectedFile);
        }
      }

      if (!record) {
        throw new Error("安装包没有保存成功，请重新选择文件后再试。");
      }
      setReleases((current) => upsertRelease(current, record));
      forceCloseArtifactEditor();
      notifications.show({
        color: "green",
        title: "发布中心",
        message: artifactEditor.artifactId ? "安装包已更新" : "安装包已新增"
      });
    } catch (reason) {
      const result = showReleaseRequestFailure(reason, "保存安装包失败");
      if (result.uncertain) {
        forceCloseArtifactEditor();
        void loadReleases();
      }
    } finally {
      endSaving(actionKey);
    }
  }

  async function removeArtifact(releaseId: string, artifactId: string) {
    const actionKey = `artifact:${releaseId}`;
    if (savingRef.current) {
      return;
    }
    if (!window.confirm("确定删除这个安装包吗？")) return;
    if (!beginSaving(actionKey)) {
      return;
    }
    try {
      releaseMutationSeqRef.current += 1;
      const record = await deleteAdminReleaseArtifact(releaseId, artifactId);
      setReleases((current) => upsertRelease(current, record));
      notifications.show({
        color: "green",
        title: "发布中心",
        message: "安装包已删除"
      });
    } catch (reason) {
      const result = showReleaseRequestFailure(reason, "删除安装包失败");
      if (result.uncertain) {
        void loadReleases();
      }
    } finally {
      endSaving(actionKey);
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
                            globalBusy={saving !== null}
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
                                        globalBusy={saving !== null}
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
        artifactEditingDisabled={isReleaseEditorArtifactEditingDisabled()}
        onClose={closeReleaseEditor}
        onChange={setReleaseForm}
        onManageArtifact={openArtifactFromReleaseEditor}
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
        uploadMaxBytes={uploadMaxBytes}
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

function validateReleaseEditorInput(
  version: string,
  form?: ReleaseEditorFormState,
  platform?: AdminReleasePlatform,
  uploadMaxBytes = DEFAULT_ADMIN_RELEASE_MAX_UPLOAD_BYTES
) {
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
    if (!form.selectedFile) return null;
    const fileMessage = validateReleaseArtifactFile(platform, form.selectedFile);
    if (fileMessage) return fileMessage;
    if (form.selectedFile.size > uploadMaxBytes) {
      return `安装包不能超过 ${formatUploadBytes(uploadMaxBytes)}。`;
    }
    return null;
  }
  const downloadUrl = form.downloadUrl.trim();
  if (!downloadUrl) {
    return null;
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

function buildUploadedArtifactPayload(
  platform: AdminReleasePlatform,
  file: File,
  fileName: string,
  isPrimary: boolean,
  fallbackType: AdminReleaseArtifactType = defaultArtifactTypeForPlatform(platform)
): UploadAdminReleaseArtifactInputDto {
  const type = inferUploadedArtifactType(platform, file.name, fallbackType);
  return {
    source: "uploaded",
    type,
    deliveryMode: deliveryModeForUploadedArtifact(platform, type),
    fileName: fileName.trim() || file.name,
    isPrimary
  };
}

function buildExternalArtifactPayload(platform: AdminReleasePlatform, downloadUrl: string, isPrimary: boolean) {
  const type = inferExternalArtifactType(platform, downloadUrl);
  return {
    source: "external" as const,
    type,
    deliveryMode: deliveryModeForExternalArtifact(platform, type),
    downloadUrl: downloadUrl.trim(),
    fileName: inferFileNameFromUrl(downloadUrl),
    isPrimary
  };
}

function inferUploadedArtifactType(
  platform: AdminReleasePlatform,
  fileName: string,
  fallbackType: AdminReleaseArtifactType
): AdminReleaseArtifactType {
  const normalized = fileName.trim().toLowerCase();
  if (platform === "windows") {
    return "zip";
  }
  return fallbackType;
}

function inferExternalArtifactType(platform: AdminReleasePlatform, downloadUrl: string): AdminReleaseArtifactType {
  const pathname = inferUrlPathname(downloadUrl);
  if (platform === "windows") {
    if (pathname.endsWith(".zip")) {
      return "zip";
    }
    return "external";
  }
  if (platform === "macos") {
    return pathname.endsWith(".dmg") ? "dmg" : "external";
  }
  if (platform === "android") {
    return pathname.endsWith(".apk") ? "apk" : "external";
  }
  return pathname.endsWith(".ipa") ? "ipa" : "external";
}

function deliveryModeForUploadedArtifact(platform: AdminReleasePlatform, type: AdminReleaseArtifactType) {
  if (platform === "windows" && type === "zip") {
    return "desktop_full_replace" as const;
  }
  if (platform === "android") {
    return "apk_download" as const;
  }
  if (platform === "ios") {
    return "external_download" as const;
  }
  return "desktop_installer_download" as const;
}

function deliveryModeForExternalArtifact(platform: AdminReleasePlatform, type: AdminReleaseArtifactType) {
  if (platform === "windows" && type === "zip") {
    return "desktop_full_replace" as const;
  }
  if (platform === "macos" && type === "dmg") {
    return "desktop_installer_download" as const;
  }
  if (platform === "android" && type === "apk") {
    return "apk_download" as const;
  }
  return "external_download" as const;
}

function inferFileNameFromUrl(downloadUrl: string) {
  try {
    const pathname = new URL(downloadUrl.trim()).pathname;
    const fileName = pathname.split("/").filter(Boolean).pop();
    return fileName ? decodeURIComponent(fileName) : null;
  } catch {
    return null;
  }
}

function inferUrlPathname(downloadUrl: string) {
  try {
    return new URL(downloadUrl.trim()).pathname.toLowerCase();
  } catch {
    return downloadUrl.trim().toLowerCase();
  }
}

function releaseFormHasArtifact(form: ReleaseEditorFormState) {
  return form.artifactSource === "uploaded" ? Boolean(form.selectedFile) : Boolean(form.downloadUrl.trim());
}

function validateReleaseArtifactFile(platform: AdminReleasePlatform | undefined, file: File) {
  if (platform === "windows" && !file.name.trim().toLowerCase().endsWith(".zip")) {
    return "Windows 静默全量更新只支持 ZIP 安装包，请上传 ChordV_x64-full.zip。";
  }
  return null;
}
