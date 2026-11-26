import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { SubscriptionLinkPublicationStatusDto, SubscriptionLinkSettingsDto } from "@chordv/shared";
import { fetchSubscriptionLinkDistribution, fetchSubscriptionLinkSettings, saveSubscriptionLinkSettings } from "../../api/subscription-links";
import { readError } from "../../utils/admin-filters";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { describeDistributionStatus, normalizeOriginInput } from "../customers/subscription-link-model";

const toneColor = { ok: "teal.9", wait: "yellow.9", off: "dimmed" } as const;

export function SubscriptionLinkSettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<SubscriptionLinkSettingsDto | null>(null);
  const [status, setStatus] = useState<SubscriptionLinkPublicationStatusDto | null>(null);
  const [origin, setOrigin] = useState(""), [backupOrigin, setBackupOrigin] = useState("");
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0), busy = useRef(false);
  const apply = (next: SubscriptionLinkSettingsDto) => { setSettings(next); setOrigin(next.origin ?? ""); setBackupOrigin(next.backupOrigin ?? ""); };
  const load = async () => {
    const id = ++epoch.current; setLoading(true); setError(null); setSettings(null); setStatus(null);
    try {
      const [nextSettings, nextStatus] = await Promise.all([fetchSubscriptionLinkSettings(), fetchSubscriptionLinkDistribution()]);
      if (id !== epoch.current) return;
      apply(nextSettings); setStatus(nextStatus);
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "订阅链接设置读取失败")); }
    finally { if (id === epoch.current) setLoading(false); }
  };
  useEffect(() => { if (opened) void load(); return () => { epoch.current++; }; }, [opened]);
  const save = async () => {
    if (busy.current || !settings) return;
    const id = epoch.current; busy.current = true; setSaving(true); setError(null);
    try {
      const result = await saveSubscriptionLinkSettings({ origin: normalizeOriginInput(origin), backupOrigin: normalizeOriginInput(backupOrigin) });
      if (id !== epoch.current) return;
      apply(result);
      notifications.show({ color: "teal", message: "订阅域名已保存" });
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "保存失败，请重新读取确认当前配置")); }
    finally { busy.current = false; if (id === epoch.current) setSaving(false); }
  };
  const swap = () => { setOrigin(backupOrigin); setBackupOrigin(origin); };
  const summary = status ? describeDistributionStatus(status) : null;
  return <Modal opened={opened} onClose={() => { if (!busy.current) onClose(); }} title="订阅链接" centered size="lg" closeOnClickOutside={false} closeOnEscape={!saving} withCloseButton={!saving}>
    <Stack gap="lg">
      {error && <Alert color="red">{error}<Button variant="subtle" disabled={saving} onClick={() => void load()}>重新读取</Button></Alert>}
      {loading ? <Text role="status">正在读取订阅链接设置…</Text> : settings && status && summary ? <>
        <Text size="sm" c="dimmed">第三方客户端的订阅链接都以这里的域名开头。保存只改变后台显示的链接地址，不会修改 DNS；域名需要已经指向订阅分发服务。更换域名后，已经发给客户的旧地址只要旧域名还在服务就继续可用。</Text>
        <TextInput label="订阅域名" description="完整的 HTTPS 地址，不带路径，例如 https://sub.example.com" value={origin} disabled={saving} onChange={event => setOrigin(event.currentTarget.value)}/>
        <TextInput label="备用域名" description="可选。主域名打不开时给客户用，内容相同。" value={backupOrigin} disabled={saving} onChange={event => setBackupOrigin(event.currentTarget.value)}/>
        <Group justify="space-between">
          <Button variant="default" disabled={saving || !origin.trim() || !backupOrigin.trim()} onClick={swap}>主备对调</Button>
          <Button loading={saving} onClick={() => void save()}>保存</Button>
        </Group>
        <div><Text size="sm" fw={550}>分发状态</Text>
          <Text size="sm" c={toneColor[summary.tone]} mt={4}>{summary.label}</Text>
          {status.lastSuccessAt ? <Text size="xs" c="dimmed" mt={4}>上次全部发布完成：{formatDateTimeWithYear(status.lastSuccessAt)}</Text> : null}</div>
      </> : null}
    </Stack>
  </Modal>;
}
