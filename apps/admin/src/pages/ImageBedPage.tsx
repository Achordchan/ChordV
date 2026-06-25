import { useEffect, useRef, useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, Loader, PasswordInput, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { AdminImageBedConfigDto, AdminImageBedFileDto } from "@chordv/shared";
import {
  deleteAdminImageBedFile,
  fetchAdminImageBedConfig,
  fetchAdminImageBedFiles,
  updateAdminImageBedConfig
} from "../api/client";
import { SectionCard } from "../features/shared/SectionCard";
import { buildUncertainMutationMessage, isPotentiallyCompletedMutationFailure, readError } from "../utils/admin-filters";

type ImageBedConfigForm = {
  baseUrl: string;
  apiToken: string;
  uploadFolder: string;
  uploadChannel: string;
  channelName: string;
};

type LoadFilesOptions = {
  afterSuccessfulSave?: boolean;
  silent?: boolean;
};

type ImageBedPageProps = {
  refreshSignal?: number;
};

export function ImageBedPage(props: ImageBedPageProps) {
  const [config, setConfig] = useState<AdminImageBedConfigDto | null>(null);
  const [form, setForm] = useState<ImageBedConfigForm>({
    baseUrl: "https://image.achord.cn",
    apiToken: "",
    uploadFolder: "support-tickets",
    uploadChannel: "",
    channelName: ""
  });
  const [files, setFiles] = useState<AdminImageBedFileDto[]>([]);
  const [search, setSearch] = useState("");
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [fileListErrorColor, setFileListErrorColor] = useState<"red" | "yellow">("red");
  const configRequestSeqRef = useRef(0);
  const configMutationSeqRef = useRef(0);
  const fileListRequestSeqRef = useRef(0);
  const fileListLoadingSeqRef = useRef<number | null>(null);
  const formDirtyRef = useRef(false);
  const savingRef = useRef(false);
  const deletingPathRef = useRef<string | null>(null);

  useEffect(() => {
    void loadConfig({ loadFilesAfter: true });
  }, []);

  useEffect(() => {
    if (!props.refreshSignal) {
      return;
    }
    void loadConfig({ silent: true }).then((nextConfig) => {
      if (nextConfig?.hasToken) {
        void loadFiles({ silent: true });
      }
    });
  }, [props.refreshSignal]);

  function updateForm(patch: Partial<ImageBedConfigForm>) {
    formDirtyRef.current = true;
    setForm((current) => ({ ...current, ...patch }));
  }

  async function loadConfig(options?: { silent?: boolean; preserveForm?: boolean; loadFilesAfter?: boolean }) {
    const requestSeq = ++configRequestSeqRef.current;
    const mutationSeqAtStart = configMutationSeqRef.current;
    try {
      if (!options?.silent) {
        setLoadingConfig(true);
        setError(null);
      }
      const nextConfig = await fetchAdminImageBedConfig();
      if (requestSeq !== configRequestSeqRef.current || mutationSeqAtStart !== configMutationSeqRef.current) {
        return null;
      }
      const preserveForm =
        options?.preserveForm ?? Boolean(options?.silent && (formDirtyRef.current || savingRef.current || saving));
      const endpointChanged =
        !config ||
        config.baseUrl !== nextConfig.baseUrl ||
        config.hasToken !== nextConfig.hasToken ||
        config.uploadFolder !== nextConfig.uploadFolder ||
        config.uploadChannel !== nextConfig.uploadChannel ||
        config.channelName !== nextConfig.channelName;
      setConfig(nextConfig);
      if (!preserveForm) {
        formDirtyRef.current = false;
        setForm({
          baseUrl: nextConfig.baseUrl,
          apiToken: "",
          uploadFolder: nextConfig.uploadFolder ?? "",
          uploadChannel: nextConfig.uploadChannel ?? "",
          channelName: nextConfig.channelName ?? ""
        });
      }
      if (!preserveForm && endpointChanged) {
        setFiles([]);
        setFileListError(null);
      }
      if (options?.loadFilesAfter && nextConfig.hasToken) {
        void loadFiles({ silent: true });
      }
      return nextConfig;
    } catch (reason) {
      if (requestSeq !== configRequestSeqRef.current || mutationSeqAtStart !== configMutationSeqRef.current) {
        return null;
      }
      if (!options?.silent) {
        setError(readError(reason, "图床配置加载失败"));
      }
      return null;
    } finally {
      if (!options?.silent) {
        setLoadingConfig(false);
      }
    }
  }

  async function loadFiles(options: LoadFilesOptions = {}) {
    const requestSeq = ++fileListRequestSeqRef.current;
    try {
      fileListLoadingSeqRef.current = requestSeq;
      setLoadingFiles(true);
      setFileListError(null);
      setFileListErrorColor("red");
      const result = await fetchAdminImageBedFiles({
        count: 50,
        search: search.trim() || undefined,
        recursive: false
      });
      if (requestSeq !== fileListRequestSeqRef.current) {
        return;
      }
      setFiles(result.files);
    } catch (reason) {
      if (requestSeq !== fileListRequestSeqRef.current) {
        return;
      }
      const message = readError(reason, "图床文件列表加载失败");
      setFileListErrorColor(options.afterSuccessfulSave ? "yellow" : "red");
      setFileListError(message);
      if (options.silent) {
        return;
      }
      notifications.show({
        color: options.afterSuccessfulSave ? "yellow" : "red",
        title: options.afterSuccessfulSave ? "配置已保存，列表刷新失败" : "图床",
        message: options.afterSuccessfulSave ? `${message}。配置保存请求已经成功返回，可稍后手动刷新列表。` : message
      });
    } finally {
      if (fileListLoadingSeqRef.current === requestSeq) {
        fileListLoadingSeqRef.current = null;
        setLoadingFiles(false);
      }
    }
  }

  async function handleSave() {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    configMutationSeqRef.current += 1;
    try {
      setSaving(true);
      const nextConfig = await updateAdminImageBedConfig({
        baseUrl: form.baseUrl.trim(),
        ...(form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}),
        uploadFolder: form.uploadFolder.trim() || null,
        uploadChannel: form.uploadChannel.trim() || null,
        channelName: form.channelName.trim() || null
      });
      configMutationSeqRef.current += 1;
      setConfig(nextConfig);
      formDirtyRef.current = false;
      setForm({
        baseUrl: nextConfig.baseUrl,
        apiToken: "",
        uploadFolder: nextConfig.uploadFolder ?? "",
        uploadChannel: nextConfig.uploadChannel ?? "",
        channelName: nextConfig.channelName ?? ""
      });
      setFileListError(null);
      setFileListErrorColor("red");
      notifications.show({
        color: "green",
        title: "图床",
        message: "图床配置已保存"
      });
      if (!nextConfig.hasToken) {
        setFiles([]);
        setFileListError(null);
      } else {
        void loadFiles({ afterSuccessfulSave: true });
      }
    } catch (reason) {
      const message = readError(reason, "图床配置保存失败");
      const uncertain = isPotentiallyCompletedMutationFailure(message);
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: "图床",
        message: uncertain ? buildUncertainMutationMessage("图床配置", message) : message
      });
      if (uncertain) {
        void loadConfig({ silent: true, preserveForm: false }).then(() => loadFiles({ silent: true }));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleClearToken() {
    if (savingRef.current) {
      return;
    }
    if (!window.confirm("确定清空图床 API Token？清空后工单附件上传会不可用。")) {
      return;
    }
    savingRef.current = true;
    configMutationSeqRef.current += 1;
    try {
      setSaving(true);
      const nextConfig = await updateAdminImageBedConfig({ apiToken: null });
      configMutationSeqRef.current += 1;
      setConfig(nextConfig);
      formDirtyRef.current = false;
      setForm({
        baseUrl: nextConfig.baseUrl,
        apiToken: "",
        uploadFolder: nextConfig.uploadFolder ?? "",
        uploadChannel: nextConfig.uploadChannel ?? "",
        channelName: nextConfig.channelName ?? ""
      });
      if (!nextConfig.hasToken) {
        setFiles([]);
        setFileListError(null);
      }
      notifications.show({
        color: "green",
        title: "图床",
        message:
          nextConfig.tokenSource === "environment"
            ? "数据库 Token 已清空，当前仍使用环境变量 Token。"
            : "图床 Token 已清空。"
      });
    } catch (reason) {
      const message = readError(reason, "清空 Token 失败");
      const uncertain = isPotentiallyCompletedMutationFailure(message);
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: "图床",
        message: uncertain ? `${message}。请求状态不确定，Token 可能已清空，请刷新页面确认。` : message
      });
      if (uncertain) {
        void loadConfig({ silent: true, preserveForm: false }).then(() => loadFiles({ silent: true }));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleDelete(file: AdminImageBedFileDto) {
    if (deletingPathRef.current) {
      return;
    }
    if (!window.confirm(`确定删除图床文件 ${file.name}？此操作不会自动删除工单消息记录。`)) {
      return;
    }
    deletingPathRef.current = file.name;
    try {
      setDeletingPath(file.name);
      const result = await deleteAdminImageBedFile(file.name);
      const deleted = new Set(result.deleted.length > 0 ? result.deleted : result.success ? [file.name] : []);
      if (deleted.size > 0) {
        fileListRequestSeqRef.current += 1;
        fileListLoadingSeqRef.current = null;
        setLoadingFiles(false);
        setFiles((current) => current.filter((item) => item.name !== file.name && !deleted.has(item.name)));
      }
      if (result.failed.length > 0) {
        notifications.show({
          color: deleted.size > 0 ? "yellow" : "red",
          title: deleted.size > 0 ? "图床文件部分删除" : "图床文件删除失败",
          message: deleted.size > 0 ? `已删除 ${deleted.size} 个文件，失败：${result.failed.join("；")}` : result.failed.join("；")
        });
        return;
      }
      if (!result.success) {
        notifications.show({
          color: "red",
          title: "图床",
          message: "图床返回删除失败"
        });
        return;
      }
      notifications.show({
        color: "green",
        title: "图床",
        message: "图床文件已删除"
      });
    } catch (reason) {
      const message = readError(reason, "删除图床文件失败");
      const uncertain = isPotentiallyCompletedMutationFailure(message);
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: "图床",
        message: uncertain ? `${message}。请求状态不确定，文件可能已删除，请刷新列表确认。` : message
      });
      if (uncertain) {
        void loadFiles({ silent: true });
        window.setTimeout(() => {
          void loadFiles({ silent: true });
        }, 3000);
      }
    } finally {
      if (deletingPathRef.current === file.name) {
        deletingPathRef.current = null;
        setDeletingPath(null);
      }
    }
  }

  if (loadingConfig) {
    return (
      <Group justify="center" py="xl" gap="sm">
        <Loader size="sm" />
        <Text c="dimmed">正在加载图床配置...</Text>
      </Group>
    );
  }

  if (!config && error) {
    return (
      <SectionCard
        title="附件图床配置"
        description="配置工单附件图床 Token，并管理已上传图片。"
        searchValue={search}
        onSearchChange={setSearch}
        onSearchSubmit={() => void loadFiles()}
        searchPlaceholder="搜索图床文件"
      >
        <Alert color="red" variant="light">
          <Stack gap="sm">
            <Text>{error}</Text>
            <Text size="sm">
              配置没有成功加载，已暂停展示默认配置，避免误保存覆盖现有图床参数。
            </Text>
            <Group>
              <Button variant="default" onClick={() => void loadConfig({ loadFilesAfter: true })}>
                重新加载配置
              </Button>
            </Group>
          </Stack>
        </Alert>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="附件图床配置"
      description="配置工单附件图床 Token，并管理已上传图片。"
      searchValue={search}
      onSearchChange={setSearch}
      onSearchSubmit={() => void loadFiles()}
      searchPlaceholder="搜索图床文件"
    >
      <Stack gap="lg">
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}

        <Card withBorder radius="xl" p="lg">
          <Stack gap="md">
            <Group justify="space-between" align="start">
              <div>
                <Title order={4}>图床 API 配置</Title>
                <Text size="sm" c="dimmed">
                  Token 只保存在后端，后台只显示脱敏状态，客户端不会拿到完整 Token。
                </Text>
              </div>
              <Badge color={config?.hasToken ? "green" : "red"} variant="light">
                {config?.hasToken ? `已配置 ${config.tokenPreview ?? ""}` : "未配置"}
              </Badge>
            </Group>

            <TextInput
              label="图床地址"
              value={form.baseUrl}
              onChange={(event) => updateForm({ baseUrl: event.currentTarget.value })}
              placeholder="https://image.achord.cn"
            />
            <PasswordInput
              label="API Token"
              value={form.apiToken}
              onChange={(event) => updateForm({ apiToken: event.currentTarget.value })}
              placeholder={config?.hasToken ? "留空则不修改现有 Token" : "请输入图床 API Token"}
            />
            <Group grow>
              <TextInput
                label="上传目录"
                value={form.uploadFolder}
                onChange={(event) => updateForm({ uploadFolder: event.currentTarget.value })}
                placeholder="support-tickets"
              />
              <TextInput
                label="上传渠道"
                value={form.uploadChannel}
                onChange={(event) => updateForm({ uploadChannel: event.currentTarget.value })}
                placeholder="留空使用图床默认渠道"
              />
              <TextInput
                label="渠道名称"
                value={form.channelName}
                onChange={(event) => updateForm({ channelName: event.currentTarget.value })}
                placeholder="留空使用图床默认渠道名"
              />
            </Group>
            <Group justify="flex-end">
              <Button variant="default" color="red" onClick={() => void handleClearToken()} disabled={!config?.hasToken || saving}>
                清空 Token
              </Button>
              <Button onClick={() => void handleSave()} loading={saving}>
                保存配置
              </Button>
            </Group>
          </Stack>
        </Card>

        <Card withBorder radius="xl" p="lg">
          <Stack gap="md">
            <Group justify="space-between">
              <div>
                <Title order={4}>图床文件</Title>
                <Text size="sm" c="dimmed">
                  使用图床列表 API 查询图片文件，可手动删除无效文件。
                </Text>
              </div>
              <Button variant="default" onClick={() => void loadFiles()} loading={loadingFiles} disabled={!config?.hasToken}>
                按当前搜索刷新
              </Button>
            </Group>

            {!config?.hasToken ? (
              <Alert color="yellow" variant="light">
                请先保存图床 API Token，再查询和删除文件。
              </Alert>
            ) : null}
            {fileListError ? (
              <Alert color={fileListErrorColor} variant="light">
                {fileListErrorColor === "yellow"
                  ? `${fileListError}。上一次配置保存已经成功返回，可稍后手动刷新列表。`
                  : fileListError}
              </Alert>
            ) : null}

            <Table.ScrollContainer minWidth={780}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>预览</Table.Th>
                    <Table.Th>文件</Table.Th>
                    <Table.Th>类型</Table.Th>
                    <Table.Th>大小</Table.Th>
                    <Table.Th>上传时间</Table.Th>
                    <Table.Th>操作</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {files.map((file) => (
                    <Table.Tr key={file.name}>
                      <Table.Td>
                        <img
                          src={file.url}
                          alt={file.name}
                          loading="lazy"
                          style={{ width: 56, height: 40, objectFit: "cover", borderRadius: 8 }}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          <Text fw={600} lineClamp={1}>
                            {file.name}
                          </Text>
                          <Anchor href={file.url} target="_blank" rel="noreferrer" size="xs">
                            打开图片
                          </Anchor>
                        </Stack>
                      </Table.Td>
                      <Table.Td>{file.mimeType ?? "-"}</Table.Td>
                      <Table.Td>{formatBytes(file.fileSizeBytes)}</Table.Td>
                      <Table.Td>{file.uploadedAt ? new Date(file.uploadedAt).toLocaleString() : "-"}</Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          loading={deletingPath === file.name}
                          disabled={Boolean(deletingPath) && deletingPath !== file.name}
                          onClick={() => void handleDelete(file)}
                        >
                          删除
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {loadingFiles && files.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={6}>
                        <Text ta="center" c="dimmed" py="xl">
                          正在加载图床文件列表...
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : null}
                  {!loadingFiles && files.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={6}>
                        <Text ta="center" c="dimmed" py="xl">
                          暂无图床文件
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : null}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        </Card>
      </Stack>
    </SectionCard>
  );
}

function formatBytes(value: string | null) {
  if (!value) {
    return "-";
  }
  const size = Number(value);
  if (!Number.isFinite(size)) {
    return value;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
