import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { SiteAddressConfigDto } from "@chordv/shared";
import { request } from "../../api/base";
import { readError } from "../../utils/admin-filters";

export function NetworkSettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [site, setSite] = useState<SiteAddressConfigDto | null>(null);
  const [aliases, setAliases] = useState("");
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0), busy = useRef(false);
  const load = async () => {
    const id = ++epoch.current; setLoading(true); setError(null); setSite(null);
    try {
      const address = await request<SiteAddressConfigDto>("/admin/site-address");
      if (id !== epoch.current) return;
      setSite(address); setAliases(address.legacyOrigins.join("\n"));
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "站点地址读取失败")); }
    finally { if (id === epoch.current) setLoading(false); }
  };
  useEffect(() => { if (opened) void load(); return () => { epoch.current++; }; }, [opened]);
  const save = async () => {
    if (busy.current || !site) return;
    const id = epoch.current; busy.current = true; setSaving(true); setError(null);
    try {
      const result = await request<SiteAddressConfigDto>("/admin/site-address", {
        method: "PUT", body: JSON.stringify({
          primaryOrigin: site.primaryOrigin,
          legacyOrigins: aliases.split("\n").map(value => value.trim()).filter(Boolean)
        })
      });
      if (id !== epoch.current) return;
      setSite(result); setAliases(result.legacyOrigins.join("\n"));
      notifications.show({ color: "teal", message: "站点地址已保存" });
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "保存失败，请重新读取确认当前配置")); }
    finally { busy.current = false; if (id === epoch.current) setSaving(false); }
  };
  return <Modal opened={opened} onClose={() => { if (!busy.current) onClose(); }} title="站点地址" centered size="lg" closeOnClickOutside={false} closeOnEscape={!saving} withCloseButton={!saving}>
    <Stack gap="lg">
      {error && <Alert color="red">{error}<Button variant="subtle" disabled={saving} onClick={() => void load()}>重新读取</Button></Alert>}
      {loading ? <Text role="status">正在读取站点地址…</Text> : site ? <>
        <Text size="sm" c="dimmed">保存不会修改 DNS 或服务器证书；版本和运行组件统一从 GitHub 发布仓库读取。</Text>
        <TextInput label="客户端主站点地址" value={site.primaryOrigin} disabled={saving} onChange={event => setSite({ ...site, primaryOrigin: event.currentTarget.value })}/>
        <Textarea label="迁移期间保留的旧地址" description="每行一个完整地址。" value={aliases} disabled={saving} onChange={event => setAliases(event.currentTarget.value)} autosize minRows={2}/>
        <Group justify="flex-end"><Button loading={saving} onClick={() => void save()}>保存站点地址</Button></Group>
      </> : null}
    </Stack>
  </Modal>;
}
