import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Stack, Textarea, TextInput } from "@mantine/core";
import { parsePanelInboundLink } from "../../api/nodes";

/** A single parser/preview shared by initial onboarding and later validation. */
export function PanelInboundForm({ onParsed }: { onParsed: (spec: Record<string, unknown> | null) => void }) {
  const [link, setLink] = useState("");
  const [manual, setManual] = useState(false);
  const [fields, setFields] = useState({ serverHost: "", port: "443", pbk: "", sid: "", sni: "", flow: "xtls-rprx-vision", fp: "chrome", spx: "/" });
  const [tag, setTag] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  const invalidate = () => { epoch.current++; setSpec(null); setBusy(false); setError(""); onParsed(null); };
  const parse = async () => {
    const current = ++epoch.current;
    setBusy(true); setError(""); setSpec(null); onParsed(null);
    try {
      const query = new URLSearchParams({ security: "reality", type: "tcp", pbk: fields.pbk, sid: fields.sid, sni: fields.sni, flow: fields.flow, fp: fields.fp, spx: fields.spx });
      const host = fields.serverHost.includes(":") && !fields.serverHost.startsWith("[") ? `[${fields.serverHost}]` : fields.serverHost;
      const input = manual ? `vless://placeholder@${host}:${fields.port}?${query}` : link;
      const parsed = await parsePanelInboundLink({ link: input, panelVersion: "auto", inboundTag: tag || undefined, tagOverrideConfirmed: confirmed });
      if (current !== epoch.current) return;
      setSpec(parsed); onParsed(parsed); setLink("");
    } catch (e) { if (current === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  return <Stack gap="sm">
    <Checkbox label="手工填写连接参数" checked={manual} onChange={e => { invalidate(); setManual(e.currentTarget.checked); }} />
    {manual ? <Stack gap="xs">{(Object.entries({ serverHost: "公网地址", port: "监听端口", pbk: "Reality 公钥", sid: "shortId（允许空）", sni: "SNI", flow: "flow（允许空）", fp: "fingerprint", spx: "spiderX" }) as [keyof typeof fields, string][]).map(([key, label]) => <TextInput key={key} label={label} value={fields[key]} onChange={e => { invalidate(); setFields({ ...fields, [key]: e.currentTarget.value }); }} />)}</Stack> : <Textarea label="vless:// 分享链接" value={link} onChange={e => { invalidate(); setLink(e.currentTarget.value); }} autosize minRows={3} />}
    <TextInput label="自定义 tag（可选，留空自动匹配实际入站）" value={tag} onChange={e => { invalidate(); setTag(e.currentTarget.value); }} />
    {tag && <><Alert color="orange">错误 tag 可能指向面板自用入站。Go agent 会同时核对实际监听端口与 Reality 公钥，拒绝不匹配。</Alert><Checkbox label="我已在面板核对自定义 tag" checked={confirmed} onChange={e => { invalidate(); setConfirmed(e.currentTarget.checked); }} /></>}
    <Group><Button loading={busy} disabled={(!manual && !link.trim()) || (Boolean(tag) && !confirmed)} onClick={() => void parse()}>解析并预览</Button></Group>
    {spec && <Alert color="teal">已解析：{String(spec.serverHost)}:{String(spec.listenPort)}。{spec.tagOverrideConfirmed ? `已指定入站 ${String(spec.inboundTag)}。` : "提交校验时自动匹配实际入站。"}</Alert>}
    {error && <Alert color="red">{error}</Alert>}
  </Stack>;
}
