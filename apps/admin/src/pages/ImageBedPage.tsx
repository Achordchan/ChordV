import { useEffect, useState } from "react";
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
import { readError } from "../utils/admin-filters";

type ImageBedConfigForm = {
  baseUrl: string;
  apiToken: string;
  uploadFolder: string;
  uploadChannel: string;
  channelName: string;
};

export function ImageBedPage() {
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

  useEffect(() => {
    void loadConfig();
  }, []);

  async function loadConfig() {
    try {
      setLoadingConfig(true);
      setError(null);
      const nextConfig = await fetchAdminImageBedConfig();
      setConfig(nextConfig);
      setForm({
        baseUrl: nextConfig.baseUrl,
        apiToken: "",
        uploadFolder: nextConfig.uploadFolder ?? "",
        uploadChannel: nextConfig.uploadChannel ?? "",
        channelName: nextConfig.channelName ?? ""
      });
      if (nextConfig.hasToken) {
        await loadFiles();
      }
    } catch (reason) {
      setError(readError(reason, "图床配置加载失败"));
    } finally {
      setLoadingConfig(false);
    }
  }

  async function loadFiles() {
    try {
      setLoadingFiles(true);
      const result = await fetchAdminImageBedFiles({
        count: 50,
        search: search.trim() || undefined,
        recursive: true
      });
      setFiles(result.files);
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "图床",
        message: readError(reason, "图床文件列表加载失败")
      });
    } finally {
      setLoadingFiles(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      const nextConfig = await updateAdminImageBedConfig({
        baseUrl: form.baseUrl.trim(),
        ...(form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}),
        uploadFolder: form.uploadFolder.trim() || null,
        uploadChannel: form.uploadChannel.trim() || null,
        channelName: form.channelName.trim() || null
      });
      setConfig(nextConfig);
      setForm((current) => ({ ...current, apiToken: "" }));
      notifications.show({
        color: "green",
        title: "图床",
        message: "图床配置已保存"
      });
      if (nextConfig.hasToken) {
        await loadFiles();
      }
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "图床",
        message: readError(reason, "图床配置保存失败")
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearToken() {
    if (!window.confirm("确定清空图床 API Token？清空后工单附件上传会不可用。")) {
      return;
    }
    try {
      setSaving(true);
      const nextConfig = await updateAdminImageBedConfig({ apiToken: null });
      setConfig(nextConfig);
      setForm((current) => ({ ...current, apiToken: "" }));
      setFiles([]);
      notifications.show({
        color: "green",
        title: "图床",
        message: "图床 Token 已清空"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "图床",
        message: readError(reason, "清空 Token 失败")
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(file: AdminImageBedFileDto) {
    if (!window.confirm(`确定删除图床文件 ${file.name}？此操作不会自动删除工单消息记录。`)) {
      return;
    }
    try {
      setDeletingPath(file.name);
      await deleteAdminImageBedFile(file.name);
      setFiles((current) => current.filter((item) => item.name !== file.name));
      notifications.show({
        color: "green",
        title: "图床",
        message: "图床文件已删除"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "图床",
        message: readError(reason, "删除图床文件失败")
      });
    } finally {
      setDeletingPath(null);
    }
  }

  if (loadingConfig) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  return (
    <SectionCard searchValue={search} onSearchChange={setSearch}>
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
              onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.currentTarget.value }))}
              placeholder="https://image.achord.cn"
            />
            <PasswordInput
              label="API Token"
              value={form.apiToken}
              onChange={(event) => setForm((current) => ({ ...current, apiToken: event.currentTarget.value }))}
              placeholder={config?.hasToken ? "留空则不修改现有 Token" : "请输入图床 API Token"}
            />
            <Group grow>
              <TextInput
                label="上传目录"
                value={form.uploadFolder}
                onChange={(event) => setForm((current) => ({ ...current, uploadFolder: event.currentTarget.value }))}
                placeholder="support-tickets"
              />
              <TextInput
                label="上传渠道"
                value={form.uploadChannel}
                onChange={(event) => setForm((current) => ({ ...current, uploadChannel: event.currentTarget.value }))}
                placeholder="留空使用图床默认渠道"
              />
              <TextInput
                label="渠道名称"
                value={form.channelName}
                onChange={(event) => setForm((current) => ({ ...current, channelName: event.currentTarget.value }))}
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
                刷新列表
              </Button>
            </Group>

            {!config?.hasToken ? (
              <Alert color="yellow" variant="light">
                请先保存图床 API Token，再查询和删除文件。
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
                          onClick={() => void handleDelete(file)}
                        >
                          删除
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {files.length === 0 ? (
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
