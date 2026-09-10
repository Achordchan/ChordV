import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Code, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { parsePanelInboundLink } from "../../api/nodes";
import { useInboundDeployment } from "./useInboundDeployment";

export function PanelInboundSection({ node, onNodeChanged }: { node: AdminNodeRecordDto; onNodeChanged: (node: AdminNodeRecordDto) => void }) {
  const [link, setLink] = useState("");
  const [manual, setManual] = useState(false);
  const [fields, setFields] = useState({ serverHost: "", port: "443", pbk: "", sid: "", sni: "", flow: "xtls-rprx-vision", fp: "chrome", spx: "/" });
  const [panelVersion, setPanelVersion] = useState("");
  const [tag, setTag] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [revision, setRevision] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  const deployment = useInboundDeployment(node.id, onNodeChanged);
  const invalidate = () => { epoch.current++; setSpec(null); setBusy(false); setError(""); };
  const parse = async () => {
    const current = ++epoch.current;
    const base = node.inboundAppliedRevision ?? "0";
    setBusy(true); setError(""); setSpec(null);
    try {
      const query = new URLSearchParams({ security: "reality", type: "tcp", pbk: fields.pbk, sid: fields.sid, sni: fields.sni, flow: fields.flow, fp: fields.fp, spx: fields.spx });
      const host = fields.serverHost.includes(":") && !fields.serverHost.startsWith("[") ? `[${fields.serverHost}]` : fields.serverHost;
      const input = manual ? `vless://placeholder@${host}:${fields.port}?${query}` : link;
      const parsed = await parsePanelInboundLink({ link: input, panelVersion, inboundTag: tag || undefined, tagOverrideConfirmed: confirmed });
      if (current !== epoch.current) return;
      setSpec(parsed); setRevision(base); setLink("");
    } catch (e) { if (current === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  return <Stack gap="sm">
    {node.isActive && <Alert color="orange">节点当前已激活，请先停用节点再导入。</Alert>}
    <Text fw={600}>面板入站导入与只读校验</Text>
    <Alert color="blue">先在 3x-ui 创建专供 ChordV 的 VLESS + Reality 入站，设为不限期、不限流量。此操作不创建入站、不重启 Xray、不轮换密钥；链接中的占位 UUID 不保存。</Alert>
    <TextInput label="面板版本（请在目标机核对，最低 3.7.0）" value={panelVersion} onChange={e => { invalidate(); setPanelVersion(e.currentTarget.value); }} />
    <Checkbox label="手工填写连接参数（兜底）" checked={manual} onChange={e => { invalidate(); setManual(e.currentTarget.checked); }} />
    {manual ? <Stack gap="xs">{(Object.entries({ serverHost: "公网地址", port: "监听端口", pbk: "Reality 公钥", sid: "shortId（允许空）", sni: "SNI", flow: "flow（允许空）", fp: "fingerprint", spx: "spiderX" }) as [keyof typeof fields, string][]).map(([key, label]) => <TextInput key={key} label={label} value={fields[key]} onChange={e => { invalidate(); setFields({ ...fields, [key]: e.currentTarget.value }); }} />)}</Stack> : <Textarea label="vless:// 分享链接" value={link} onChange={e => { invalidate(); setLink(e.currentTarget.value); }} autosize minRows={3} />}
    <TextInput label="自定义 tag（可选，默认由链接端口推导 inbound-端口）" value={tag} onChange={e => { invalidate(); setTag(e.currentTarget.value); }} />
    {tag && <><Alert color="orange">错误 tag 可能指向面板自用入站。Go agent 会同时核对实际监听端口与 Reality 公钥，拒绝不匹配。</Alert><Checkbox label="我已在面板核对自定义 tag" checked={confirmed} onChange={e => { invalidate(); setConfirmed(e.currentTarget.checked); }} /></>}
    <Group><Button loading={busy} disabled={(!manual && !link.trim()) || !panelVersion.trim()} onClick={() => void parse()}>解析并预览</Button></Group>
    {spec && <>
      <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(spec, null, 2)}</Code>
      <Text size="xs">版本为管理员声明；agent 校验的是实时入站参数。统计策略、面板版本与公网连接仍需按接入手册验收，成功后不会自动激活节点。</Text>
      <Button loading={deployment.deploying} disabled={node.isActive || revision !== (node.inboundAppliedRevision ?? "0") || !node.agent?.version?.startsWith("go-")} onClick={() => void deployment.deploy(node, spec, revision)}>下发只读校验并保存连接参数</Button>
    </>}
    {!node.agent?.version?.startsWith("go-") && <Alert color="orange">需要先连接本版本 Go agent（版本以 go- 开头）。不要对面板主机运行旧的 Node/Xray 自动安装脚本。</Alert>}
    {(error || deployment.error) && <Alert color="red">{error || deployment.error}</Alert>}
    {deployment.stage === "done" && <Alert color="teal">入站校验完成，连接参数已保存；请继续实际流量验收后手工激活。</Alert>}
  </Stack>;
}
