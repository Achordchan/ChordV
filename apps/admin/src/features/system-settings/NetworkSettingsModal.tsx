import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { AdminDownloadMirrorConfigDto, SiteAddressConfigDto } from "@chordv/shared";
import { request } from "../../api/base";
import { fetchAdminDownloadMirrorConfig, updateAdminDownloadMirrorConfig } from "../../api/client";
import { readError } from "../../utils/admin-filters";

export function NetworkSettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [site, setSite] = useState<SiteAddressConfigDto | null>(null);
  const [mirror, setMirror] = useState<AdminDownloadMirrorConfigDto | null>(null);
  const [aliases, setAliases] = useState("");
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0), busy = useRef(false);
  const load = async () => {
    const id = ++epoch.current; setLoading(true); setError(null); setSite(null); setMirror(null);
    try {
      const [address, mirrors] = await Promise.all([request<SiteAddressConfigDto>("/admin/site-address"), fetchAdminDownloadMirrorConfig()]);
      if (id !== epoch.current) return;
      setSite(address); setAliases(address.legacyOrigins.join("\n")); setMirror(mirrors);
    } catch (reason) { if (id === epoch.current) setError(readError(reason, "网络设置读取失败")); }
    finally { if (id === epoch.current) setLoading(false); }
  };
  useEffect(() => { if (opened) void load(); return () => { epoch.current++; }; }, [opened]);
  const save = async (target: "site" | "mirror") => {
    if (busy.current || !site || !mirror) return;
    const id = epoch.current; busy.current = true; setSaving(true); setError(null);
    try {
      if (target === "site") {
        const result = await request<SiteAddressConfigDto>("/admin/site-address", { method: "PUT", body: JSON.stringify({primaryOrigin:site.primaryOrigin, legacyOrigins:aliases.split("\n").map(s=>s.trim()).filter(Boolean)}) });
        if (id !== epoch.current) return;
        setSite(result); setAliases(result.legacyOrigins.join("\n"));
      } else {
        const result = await updateAdminDownloadMirrorConfig({defaultMirrorPrefix:mirror.defaultMirrorPrefix,allowClientMirror:mirror.allowClientMirror,useMirrorForSystemUpdate:mirror.useMirrorForSystemUpdate});
        if (id !== epoch.current) return;
        setMirror(result);
      }
      notifications.show({color:"teal",message:target === "site" ? "站点地址已保存" : "全局镜像已保存"});
    } catch (reason) { if (id === epoch.current) setError(readError(reason,"保存失败，请重新读取确认当前配置")); }
    finally { busy.current=false; if(id===epoch.current)setSaving(false); }
  };
  return <Modal opened={opened} onClose={()=>{if(!busy.current)onClose();}} title="站点地址" centered size="lg" closeOnClickOutside={false} closeOnEscape={!saving} withCloseButton={!saving}>
    <Stack gap="lg">
      {error && <Alert color="red">{error}<Button variant="subtle" disabled={saving} onClick={()=>void load()}>重新读取</Button></Alert>}
      {loading ? <Text role="status">正在读取网络设置…</Text> : site && mirror ? <>
        <Text size="sm" c="dimmed">主地址用于本站下载链接和新版客户端的地址发现。保存不会修改 DNS 或服务器证书，旧客户端仍需保留原域名服务。</Text>
        <TextInput label="客户端主站点地址" description="例如 https://v.achord.cn" value={site.primaryOrigin} disabled={saving} onChange={e=>setSite({...site,primaryOrigin:e.currentTarget.value})}/>
        <Textarea label="迁移期间保留的旧地址" description="每行一个完整 HTTPS 地址；用于地址发现和跨域兼容。" value={aliases} disabled={saving} onChange={e=>setAliases(e.currentTarget.value)} autosize minRows={2}/>
        <Group justify="flex-end"><Button loading={saving} onClick={()=>void save("site")}>保存站点地址</Button></Group>
        <details><summary>兼容设置：旧外链与后台更新镜像</summary><Stack gap="md" mt="md">
        <Textarea label="全局下载镜像" description="仅供旧外链及后台自更新使用；本站托管文件不需要配置。每行一个镜像前缀，留空直连。" autosize minRows={2} value={mirror.defaultMirrorPrefix??""} disabled={saving} onChange={e=>setMirror({...mirror,defaultMirrorPrefix:e.currentTarget.value||null})}/>
        <Switch label="允许客户端自定义镜像" checked={mirror.allowClientMirror} disabled={saving} onChange={e=>setMirror({...mirror,allowClientMirror:e.currentTarget.checked})}/>
        <Switch label="后台自更新也使用镜像" checked={mirror.useMirrorForSystemUpdate} disabled={saving} onChange={e=>setMirror({...mirror,useMirrorForSystemUpdate:e.currentTarget.checked})}/>
        <Group justify="flex-end"><Button loading={saving} onClick={()=>void save("mirror")}>保存镜像</Button></Group></Stack></details>
      </> : null}
    </Stack>
  </Modal>;
}
