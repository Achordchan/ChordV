import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, CopyButton, Group, Modal, PasswordInput, Stack, Switch, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { AdminSupportIntegrationConfigDto, AdminSupportIntegrationTestResultDto, UpdateAdminSupportIntegrationConfigInputDto } from "@chordv/shared";
import { fetchSupportIntegrationConfig, testSupportIntegration, updateSupportIntegrationConfig } from "../../api/support-integration";
import { useActionConfirmation } from "../modals/useActionConfirmation";
import { readError } from "../../utils/admin-filters";

type SecretKey = "clientSecret" | "webhookSecret";
type Draft = { enabled: boolean; baseUrl: string; clientId: string; clientSecret: string; webhookSecret: string };

const SECRET_LABELS: Record<SecretKey, string> = { clientSecret: "Client Secret", webhookSecret: "Webhook Secret" };

/**
 * 工单系统（Achord Connect）接入设置。两个密钥只写不读：接口只告诉我们“已设置 / 未设置”，
 * 输入框里只有管理员这次新粘贴的值，保存或关闭后立即清空。
 */
export function SupportIntegrationModal({ opened, onClose, onSaved }: { opened: boolean; onClose: () => void; onSaved?: () => void }) {
  const [config, setConfig] = useState<AdminSupportIntegrationConfigDto | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AdminSupportIntegrationTestResultDto | null>(null);
  const epoch = useRef(0), busy = useRef(false);
  const confirmation = useActionConfirmation(opened);

  const apply = (next: AdminSupportIntegrationConfigDto) => {
    setConfig(next);
    setDraft({ enabled: next.enabled, baseUrl: next.baseUrl ?? "", clientId: next.clientId ?? "", clientSecret: "", webhookSecret: "" });
  };
  const load = async () => {
    const id = ++epoch.current; setLoading(true); setError(null); setConfig(null); setTestResult(null); setDraft(emptyDraft());
    try {
      const next = await fetchSupportIntegrationConfig();
      if (id === epoch.current) apply(next);
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "工单系统接入设置读取失败")); }
    finally { if (id === epoch.current) setLoading(false); }
  };
  useEffect(() => { if (opened) void load(); else setDraft(emptyDraft()); return () => { epoch.current++; }; }, [opened]);

  const save = async (input: UpdateAdminSupportIntegrationConfigInputDto, message: string) => {
    if (busy.current) return;
    const id = epoch.current; busy.current = true; setSaving(true); setError(null); setTestResult(null);
    try {
      const next = await updateSupportIntegrationConfig(input);
      if (id !== epoch.current) return;
      apply(next);
      onSaved?.();
      notifications.show({ color: "teal", message });
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "保存失败，请重新读取确认当前设置")); }
    finally { busy.current = false; if (id === epoch.current) setSaving(false); }
  };
  const saveDraft = () => {
    const input: UpdateAdminSupportIntegrationConfigInputDto = { enabled: draft.enabled, baseUrl: draft.baseUrl.trim() || null, clientId: draft.clientId.trim() || null };
    // 密钥输入框留空表示保持不变，只有新粘贴的值才提交。
    if (draft.clientSecret.trim()) input.clientSecret = draft.clientSecret.trim();
    if (draft.webhookSecret.trim()) input.webhookSecret = draft.webhookSecret.trim();
    void save(input, "工单系统接入设置已保存");
  };
  const clearSecret = async (key: SecretKey) => {
    const label = SECRET_LABELS[key];
    const effect = key === "clientSecret" ? "清除后客户端将无法打开工单系统，并会自动停用接入。" : "清除后工单系统推送的未读提醒会被拒绝。";
    if (!await confirmation.confirm({ title: `清除 ${label}`, message: effect, confirmLabel: "确认清除", danger: true })) return;
    void save(key === "clientSecret" ? { clientSecret: null, enabled: false } : { webhookSecret: null }, `${label} 已清除`);
  };
  const test = async () => {
    if (busy.current) return;
    const id = epoch.current; busy.current = true; setTesting(true); setError(null); setTestResult(null);
    try {
      const result = await testSupportIntegration();
      if (id === epoch.current) setTestResult(result);
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "测试连接失败，请稍后重试")); }
    finally { busy.current = false; if (id === epoch.current) setTesting(false); }
  };
  const disabled = saving || testing;
  const dirty = Boolean(config) && (draft.enabled !== config?.enabled || draft.baseUrl.trim() !== (config?.baseUrl ?? "") || draft.clientId.trim() !== (config?.clientId ?? "") || Boolean(draft.clientSecret.trim()) || Boolean(draft.webhookSecret.trim()));

  const secretField = (key: SecretKey) => {
    const hasValue = key === "clientSecret" ? config?.hasClientSecret : config?.hasWebhookSecret;
    return <Stack gap={6}>
      <Group justify="space-between" gap="xs">
        <Group gap="xs"><Text size="sm" fw={500}>{SECRET_LABELS[key]}</Text><Badge size="sm" variant="light" color={hasValue ? "teal" : "gray"}>{hasValue ? "已设置" : "未设置"}</Badge></Group>
        {hasValue ? <Button size="compact-xs" variant="subtle" color="red" disabled={disabled} onClick={() => void clearSecret(key)}>清除</Button> : null}
      </Group>
      <PasswordInput aria-label={SECRET_LABELS[key]} autoComplete="new-password" placeholder={hasValue ? "已保存，不会显示；如需更换请粘贴新的值" : `粘贴 ${SECRET_LABELS[key]}`} value={draft[key]} disabled={disabled} onChange={e => setDraft({ ...draft, [key]: e.currentTarget.value })}/>
    </Stack>;
  };

  return <Modal opened={opened} onClose={() => { if (!busy.current) onClose(); }} title="工单系统接入" centered size="lg" closeOnClickOutside={false} closeOnEscape={!disabled} withCloseButton={!disabled}>
    {confirmation.dialog}
    <Stack gap="lg">
      {error && <Alert color="red">{error}<Button variant="subtle" disabled={disabled} onClick={() => void load()}>重新读取</Button></Alert>}
      {loading ? <Text role="status">正在读取工单系统接入设置…</Text> : config ? <>
        <Text size="sm" c="dimmed">客户端的“工单”入口会打开 Achord Connect。请在 Achord Connect 的连接配置里复制地址和凭据填到这里，并把下面的 Webhook 地址填回 Achord Connect。密钥保存后不会再显示。</Text>
        <Switch label="启用新工单系统" description="启用后客户端使用新工单系统，自建工单转为只读（旧版客户端提交工单会提示升级）；关闭时客户端提示“工单系统暂未开放”" checked={draft.enabled} disabled={disabled} onChange={e => setDraft({ ...draft, enabled: e.currentTarget.checked })}/>
        <TextInput label="工单系统地址" description="例如 https://support.achord.cn" value={draft.baseUrl} disabled={disabled} onChange={e => setDraft({ ...draft, baseUrl: e.currentTarget.value })}/>
        <TextInput label="Client ID" value={draft.clientId} disabled={disabled} onChange={e => setDraft({ ...draft, clientId: e.currentTarget.value })}/>
        {secretField("clientSecret")}
        {secretField("webhookSecret")}
        <Stack gap={6}>
          <Text size="sm" fw={500}>Webhook 地址</Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput aria-label="Webhook 地址" readOnly value={config.webhookUrl} style={{ flex: 1 }}/>
            <CopyButton value={config.webhookUrl} timeout={2000}>{({ copied, copy }) => <Button variant="light" color="teal.9" onClick={copy}>{copied ? "已复制" : "复制"}</Button>}</CopyButton>
          </Group>
          <Text size="xs" c="dimmed">填到 Achord Connect 连接配置的 Webhook 地址，并订阅“未读变化”事件。地址随站点主地址变化。</Text>
        </Stack>
        {config.enabled && !config.hasWebhookSecret ? <Alert color="yellow">尚未设置 Webhook Secret：工单系统推送的未读提醒会被拒绝，客户端的未读数只能靠定期查询校准。</Alert> : null}
        {testResult ? <Alert color={testResult.ok ? "teal" : "red"} title={testResult.ok ? "连接正常" : "连接未通过"}>
          <Text size="sm">创建工单入口：{testResult.launch.message}</Text>
          <Text size="sm">未读查询：{testResult.unread.message}</Text>
        </Alert> : null}
        <Group justify="space-between">
          <Button variant="default" loading={testing} disabled={saving || dirty} onClick={() => void test()} title={dirty ? "请先保存，测试使用已保存的设置" : undefined}>测试连接</Button>
          <Button loading={saving} disabled={testing} onClick={saveDraft}>保存</Button>
        </Group>
        {dirty ? <Text size="xs" c="dimmed" ta="right">有未保存的修改；测试连接使用已保存的设置。</Text> : null}
      </> : null}
    </Stack>
  </Modal>;
}

function emptyDraft(): Draft {
  return { enabled: false, baseUrl: "", clientId: "", clientSecret: "", webhookSecret: "" };
}
