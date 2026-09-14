import { useEffect, useRef, useState } from "react";
import { Button, Group, Modal, Select, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { IconDownload, IconSettings } from "@tabler/icons-react";
import { fetchComponentDeliveries, acquireComponent, activateComponentVersion, setComponentAutoLatest, type ComponentDelivery } from "../../api/runtime-versions";
import { subscribeAdminRuntimeEvents } from "../../api/client";
import { DataSkeleton } from "../shared/DataSkeleton";
import { DataTable } from "../shared/DataTable";
import { readError } from "../../utils/admin-filters";
import { useActionConfirmation } from "../modals/useActionConfirmation";
import dialog from "../editors/EditorDialog.module.css";
import styles from "./ComponentDelivery.module.css";
import { ComponentError } from "./ComponentError";
import { request } from "../../api/base";
import { RuntimeComponentsPage } from "../../pages/RuntimeComponentsPage";
import { isRuntimeVersionUnavailable } from "../../utils/runtime-version-capability";

const names = { xray: "Xray", geoip: "GeoIP", geosite: "GeoSite" };
const platformNames: Record<string,string> = {macos:"macOS",windows:"Windows",android:"Android",ios:"iOS"};
const statusNames: Record<string,string> = { queued:"等待获取",downloading:"获取中",verifying:"校验中",ready:"已就绪",failed:"获取失败",unchanged:"已是当前版本" };
export function ComponentDeliveryPage({ refreshSignal, sessionActive = true }: { refreshSignal?: number; sessionActive?: boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  const [rows,setRows]=useState<ComponentDelivery[]>([]), [loading,setLoading]=useState(true),[error,setError]=useState("");
  const [busy,setBusy]=useState(false),[target,setTarget]=useState<ComponentDelivery|null>(null),[creating,setCreating]=useState(false);
  const [source,setSource]=useState(""),[version,setVersion]=useState(""),[auto,setAuto]=useState(false);
  const [kind,setKind]=useState<ComponentDelivery["kind"]>("xray"),[platform,setPlatform]=useState<ComponentDelivery["platform"]>("windows"),[arch,setArch]=useState<"x64"|"arm64">("x64");
  const [formError,setFormError]=useState("");
  const [errorContext,setErrorContext]=useState<"tags"|"submit">("tags");
  const [xrayExpanded,setXrayExpanded]=useState(false);
  const xrayRows=rows.filter(row=>row.kind==="xray");
  const activeVersions=[...new Set(xrayRows.filter(row=>row.enabled&&row.active).map(row=>row.active!.versionLabel))];
  const pendingCount=xrayRows.filter(row=>row.versions[0]&&["queued","downloading","verifying"].includes(row.versions[0].status)).length;
  const failureCount=xrayRows.filter(row=>row.versions[0]?.status==="failed").length;
  const readyCount=xrayRows.filter(row=>row.versions[0]?.status==="ready"&&row.versions[0].id!==row.active?.id).length;
  const [tags,setTags]=useState<Array<{value:string;label:string}>>([]),[tagsLoading,setTagsLoading]=useState(false);
  const tagsEpoch=useRef(0);
  const loadTags=async()=>{const id=++tagsEpoch.current;setFormError("");setErrorContext("tags");setTagsLoading(true);try{const values=await request<Array<{value:string;label:string}>>(`/admin/runtime-versions/github-tags?url=${encodeURIComponent(source)}`,{timeoutMs:55_000});if(alive.current&&id===tagsEpoch.current){setTags(values);if(!values.length)setFormError("该来源没有可选的稳定版本，请检查来源或填写准确的发布标签。");}}catch(e){if(alive.current&&id===tagsEpoch.current)setFormError(readError(e,"版本列表获取失败"));}finally{if(alive.current&&id===tagsEpoch.current)setTagsLoading(false);}};
  const alive=useRef(false), epoch=useRef(0), pending=useRef(false), dirty=useRef(false), saving=useRef(false);
  const confirmation=useActionConfirmation(sessionActive);
  const load=async()=>{
    if(pending.current){dirty.current=true;return;} pending.current=true; const id=++epoch.current;
    try {const result=await fetchComponentDeliveries();if(alive.current&&id===epoch.current){setRows(result);setUnavailable(false);setError("");}}
    catch(e){if(alive.current){setUnavailable(isRuntimeVersionUnavailable(e));setError(readError(e,"组件版本加载失败"));}}
    finally {pending.current=false;if(alive.current){setLoading(false);if(dirty.current){dirty.current=false;void load();}}}
  };
  useEffect(()=>{alive.current=true;void load();const stop=subscribeAdminRuntimeEvents(e=>{if(e.type==="runtime_component_updated"||e.type==="node_access_updated"&&!e.nodeId)void load();});return()=>{alive.current=false;epoch.current++;stop();};},[]);
  useEffect(()=>{if (refreshSignal !== undefined) void load();},[refreshSignal]);
  const open=(row:ComponentDelivery)=>{setTarget(row);setCreating(false);setSource(row.sourceUrl);setVersion(row.active?.versionLabel||"");setAuto(row.autoLatest);setKind(row.kind);setArch(row.architecture);setFormError("");setTags([]);setTagsLoading(false);tagsEpoch.current++;};
  const run=async(action:()=>Promise<unknown>)=>{if(saving.current)return;saving.current=true;setBusy(true);try{await action();await load();}catch(e){setError(readError(e,"操作失败"));}finally{saving.current=false;if(alive.current)setBusy(false);}};
  const submit=async()=>{
    if(saving.current)return;setFormError("");setErrorContext("submit");saving.current=true;setBusy(true);
    try{
      let url=source.trim();
      // Version selection pins a GitHub asset without asking the user to edit the URL.
      if(!auto&&version.trim()) url=url.replace(/\/releases\/(?:latest\/download|download\/[^/]+)\//,`/releases/download/${version.trim()}/`);
      let componentId=target?.id;
      if(!componentId){const created=await request<{id:string}>("/admin/runtime-versions/slots",{method:"POST",body:JSON.stringify({kind,platform,architecture:arch,sourceUrl:url})});componentId=created.id;setTarget({id:created.id,kind,platform,architecture:arch,sourceUrl:url,autoLatest:false,enabled:false,managed:false,active:null,versions:[]});setCreating(false);}
      await acquireComponent({componentId,sourceUrl:url,version:version.trim()||undefined,autoLatest:kind!=="xray"&&auto});
      setTarget(null);setCreating(false);await load();
    }catch(e){setFormError(readError(e,"获取任务创建失败"));}finally{saving.current=false;if(alive.current)setBusy(false);}
  };
  if (unavailable) return <RuntimeComponentsPage refreshSignal={refreshSignal}/>;
  return <section className={styles.workspace}>{confirmation.dialog}
    <Group justify="space-between" mb="xl"><div><Text size="lg" fw={600}>组件分发总览</Text><Text size="sm" c="dimmed" mt={6}>固定版本由本站分发；新文件准备失败时保留当前版本。</Text></div><Button color="teal.9" leftSection={<IconDownload size={16}/>} disabled={busy} onClick={()=>{setTarget(null);setCreating(true);setKind("xray");setTags([]);setTagsLoading(false);tagsEpoch.current++;setSource("");setVersion("");setAuto(false);setFormError("");}}>获取组件版本</Button></Group>
    {error?<ComponentError title="组件操作未完成" message={error} onRetry={()=>void load()}/>:null}
    {loading&&!rows.length?<DataSkeleton rows={4}/>:<div className={styles.table}><DataTable minWidth={1000}><Table.Thead><Table.Tr>{["组件与目标","当前启用","准备版本","更新策略","操作"].map(t=><Table.Th key={t}>{t}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{xrayRows.length ? <Table.Tr className={styles.groupRow}><Table.Td><Text fw={650}>Xray</Text><Text size="sm" c="dimmed" mt={5}>{xrayRows.length} 个平台与架构</Text></Table.Td><Table.Td><Text size="sm">{activeVersions.length===1 ? activeVersions[0] : activeVersions.length ? "各平台版本不同" : "尚未启用固定版本"}</Text></Table.Td><Table.Td><Text size="sm">{pendingCount ? pendingCount+" 项获取中" : readyCount ? readyCount+" 项待启用" : "暂无待处理版本"}</Text>{failureCount ? <Text size="sm" c="red.8">{failureCount} 项获取失败</Text> : null}</Table.Td><Table.Td><Text size="sm">手动选择版本</Text></Table.Td><Table.Td><Button variant="default" color="teal.9" aria-expanded={xrayExpanded} onClick={()=>setXrayExpanded(value=>!value)}>{xrayExpanded?"收起平台":"管理平台"}</Button></Table.Td></Table.Tr> : null}{rows.filter(row=>row.kind!=="xray"||xrayExpanded).map(row=>{
      const latest=row.versions[0], working=latest&&["queued","downloading","verifying"].includes(latest.status), ready=latest?.status==="ready"&&latest.id!==row.active?.id;
      return <Table.Tr key={row.id} className={row.kind==="xray"?styles.platformRow:undefined}><Table.Td><Text fw={600}>{row.kind==="xray"?platformNames[row.platform]:names[row.kind]}</Text><Text size="sm" c="dimmed" mt={5}>{row.kind==="xray"?row.architecture.toUpperCase():"全平台通用"}</Text></Table.Td>
        <Table.Td><Text size="sm">{row.active?.versionLabel|| (row.enabled?"原有来源":"未启用")}</Text><Text size="xs" c="dimmed">{row.active?"本站分发":"尚未迁移到固定版本"}{row.active&&!row.enabled?" · 已停用":""}</Text></Table.Td>
        <Table.Td><Text size="sm">{latest?.versionLabel||latest?.requestedVersion||"—"}</Text>{latest?<Text size="sm" c={latest.status==="failed"?"red":"dimmed"}>{latest.id===row.active?.id?"已启用":statusNames[latest.status]||latest.status}{latest.status==="downloading"?` · ${(Number(latest.bytesReceived)/1048576).toFixed(1)} MB`:""}</Text>:null}{latest?.lastError?<details className={styles.details}><summary>错误详情</summary><p>{latest.lastError}</p></details>:null}</Table.Td>
        <Table.Td>{row.kind==="xray"?<Text size="sm">手动选择版本</Text>:<Switch label="自动获取最新" checked={row.autoLatest} disabled={busy||!row.managed} color="teal.9" onChange={e=>{const checked=e.currentTarget.checked;void run(()=>setComponentAutoLatest(row.id,checked));}}/> }</Table.Td>
        <Table.Td><Group gap="xs">{ready?<Button size="xs" color="teal.9" disabled={busy} onClick={()=>void run(async()=>{if(await confirmation.confirm({title:"启用组件版本",message:`将 ${names[row.kind]} 切换到 ${latest.versionLabel}。对应平台的新版客户端将收到通知并自动同步；连接中在断开后应用，离线时重连后同步。`,confirmLabel:"启用版本"}))await activateComponentVersion(latest.id);})}>启用</Button>:null}<Button size="xs" variant="default" disabled={busy||Boolean(working)} leftSection={<IconSettings size={14}/>} onClick={()=>open(row)}>{working?"处理中":row.kind==="xray"?"选择版本":"获取 / 设置"}</Button></Group><details className={styles.details}><summary>历史版本</summary>{row.versions.map(v=><p key={v.id}>{v.versionLabel||v.requestedVersion||"解析中"} · {statusNames[v.status]||v.status}{v.publishedAt?" · 曾启用":""}</p>)}</details></Table.Td></Table.Tr>;
    })}{!rows.length?<Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="xl">尚未配置运行组件</Text></Table.Td></Table.Tr>:null}</Table.Tbody></DataTable></div>}
    <Modal opened={creating||Boolean(target)} onClose={()=>{if(!busy){setTarget(null);setCreating(false);}}} title="获取组件版本" centered size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy} classNames={{content:dialog.content,header:dialog.header,title:dialog.title,body:dialog.body}}><Stack gap="lg" pb="lg" className={dialog.form}>
      {creating?<><Select label="组件" value={kind} onChange={v=>{setKind(v as typeof kind);setAuto(v !== "xray");}} data={Object.entries(names).map(([value,label])=>({value,label}))}/>{kind==="xray"?<Group grow><Select label="平台" value={platform} onChange={v=>setPlatform(v as typeof platform)} data={["windows","macos","android","ios"]}/><Select label="架构" value={arch} onChange={v=>setArch(v as typeof arch)} data={["x64","arm64"]}/></Group>:null}</>:<Text fw={600}>{names[kind]} · {kind==="xray"?`${target?.platform} / ${target?.architecture}`:"全平台通用"}</Text>}
      <TextInput label="获取来源" description="GitHub Release 文件地址或 HTTPS 文件直链" value={source} disabled={busy} onChange={e=>{setSource(e.currentTarget.value);setTags([]);setTagsLoading(false);tagsEpoch.current++;}}/>
      {kind!=="xray"?<Switch label="自动获取最新" description="每 6 小时检查 GitHub 最新发布，下载并校验成功后自动启用。" checked={auto} disabled={busy} onChange={e=>setAuto(e.currentTarget.checked)} color="teal.9"/>:null}
      {kind==="xray"?<Group align="flex-end"><Select label="GitHub 发布版本" placeholder={tagsLoading?"正在读取版本…":tags.length?"选择要分发的版本":"先读取版本列表"} searchable data={tags} value={tags.some(t=>t.value===version)?version:null} onChange={v=>v&&setVersion(v)} disabled={busy||tagsLoading||!tags.length}/><Button variant="default" loading={tagsLoading} disabled={busy||!source.trim()} onClick={()=>void loadTags()}>{tagsLoading?"正在读取":tags.length?"重新读取版本":"读取可选版本"}</Button></Group>:null}
      {kind==="xray"&&tags.length>0&&!tagsLoading?<Text className={styles.readSuccess} role="status">已读取 {tags.length} 个稳定版本，请在上方选择要分发的版本。</Text>:null}
      {!auto?<TextInput label={kind==="xray"?"选择固定版本（Release tag）":"固定版本号"} description={kind==="xray"?"填写准确的发布标签；latest 下载地址将替换为此版本。":undefined} value={version} disabled={busy} onChange={e=>setVersion(e.currentTarget.value)}/>:null}
      {formError?<ComponentError title={errorContext==="tags"?"无法读取版本列表":"无法创建获取任务"} message={formError} onRetry={errorContext==="tags"?()=>void loadTags():undefined} retrying={tagsLoading}/>:null}<Group justify="flex-end"><Button variant="default" disabled={busy} onClick={()=>{setTarget(null);setCreating(false);}}>取消</Button><Button color="teal.9" loading={busy} disabled={!source.trim()||(!auto&&!version.trim())} onClick={()=>void submit()}>获取并校验</Button></Group>
    </Stack></Modal>
  </section>;
}
