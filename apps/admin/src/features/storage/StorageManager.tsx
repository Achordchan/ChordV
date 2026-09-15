import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Table, Text, TextInput } from "@mantine/core";
import { request } from "../../api/base";
import { DataTable } from "../shared/DataTable";
import { useActionConfirmation } from "../modals/useActionConfirmation";
import { listStorage, scanStorage, type StorageSnapshot } from "./storage-api";
import styles from "./StorageManager.module.css";
const bytes=(value:number)=>value>=1024**3?`${(value/1024**3).toFixed(2)} GB`:`${(value/1024**2).toFixed(1)} MB`;
const states={referenced:"使用中",orphan:"可清理",protected:"保留中",missing:"文件缺失"};
export function StorageManager({opened,onClose,onOpenAttachments}:{opened:boolean;onClose:()=>void;onOpenAttachments:()=>void}) {
  const [data,setData]=useState<StorageSnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState(""),[search,setSearch]=useState(""),[page,setPage]=useState(0),[cleanupPage,setCleanupPage]=useState(0);
  const abort=useRef<AbortController|null>(null),epoch=useRef(0),readSeq=useRef(0),busyRef=useRef(false);
  const confirmation=useActionConfirmation(opened);
  useEffect(()=>{const current=++epoch.current, sequence=++readSeq.current;setBusy(false);busyRef.current=false;setError("");setProgress("");if(opened)void listStorage().then(value=>{if(current===epoch.current&&sequence===readSeq.current){setData(value);setPage(0);setCleanupPage(0);setSearch("");}}).catch(reason=>{if(current===epoch.current)setError(String(reason));});return()=>{epoch.current++;abort.current?.abort();};},[opened]);
  const scan=async()=>{if(busyRef.current)return;busyRef.current=true;readSeq.current++;setBusy(true);setError("");const current=epoch.current;const controller=new AbortController();abort.current=controller;
    try{const snapshot=await scanStorage(controller.signal,setProgress);if(current===epoch.current){setData(snapshot);setPage(0);setCleanupPage(0);setSearch("");}}
    catch(reason){if(current===epoch.current&&!controller.signal.aborted)setError(reason instanceof Error?reason.message:"扫描失败");}finally{if(current===epoch.current){setBusy(false);busyRef.current=false;setProgress("");}if(abort.current===controller)abort.current=null;}};
  const load=async(next=0)=>{
    if(busyRef.current)return;
    const current=epoch.current, sequence=++readSeq.current;setError("");
    try{const result=await listStorage(next,search);if(current===epoch.current&&sequence===readSeq.current){setData(result);setPage(next);setCleanupPage(0);}}
    catch(reason){if(current===epoch.current&&sequence===readSeq.current)setError(String(reason));}
  };
  const mutate=async(url:string,body?:unknown)=>{
    if(busyRef.current)return;busyRef.current=true;readSeq.current++;setBusy(true);setError("");
    const current=epoch.current;let controller:AbortController|null=null;
    try{
      await request(url,{method:"POST",...(body?{body:JSON.stringify(body)}:{})});
      if(current!==epoch.current)return;
      controller=new AbortController();abort.current=controller;
      const result=await scanStorage(controller.signal,setProgress);
      if(current===epoch.current){setData(result);setPage(0);setCleanupPage(0);setSearch("");}
    }catch(reason){if(current===epoch.current&&!controller?.signal.aborted)setError(String(reason));}
    finally{if(current===epoch.current){setBusy(false);busyRef.current=false;setProgress("");}if(abort.current===controller)abort.current=null;}
  };
  const cleanup=async(ids:string[])=>{
    if(!await confirmation.confirm({title:"清理未引用文件",message:`将清理选中的 ${ids.length} 个文件。服务器会再次核对引用及最近修改时间，使用中的文件不会删除。硬链接文件的实际释放量以其他引用是否存在为准。`,confirmLabel:"确认清理",danger:true}))return;
    await mutate("/admin/storage/cleanup",{ids});
  };
  const retry=(id:string)=>mutate(`/admin/storage/cleanup/${id}/retry`);
  const moreJobs=async()=>{const current=epoch.current;try{const next=await listStorage(page,search,cleanupPage+1);if(current===epoch.current){setData(value=>value?{...value,cleanupTotal:next.cleanupTotal,cleanupJobs:[...new Map([...value.cleanupJobs,...next.cleanupJobs].map(job=>[job.id,job])).values()]}:next);setCleanupPage(cleanupPage+1);}}catch(reason){if(current===epoch.current)setError(String(reason));}};
  return <Modal opened={opened} onClose={()=>{abort.current?.abort();setBusy(false);busyRef.current=false;onClose();}} title="文件与存储" centered size={1100}><div className={styles.root}>{confirmation.dialog}
    <Group justify="space-between"><Text size="sm" c="dimmed">{data?.scannedAt?`上次扫描 ${new Date(data.scannedAt).toLocaleString("zh-CN")}`:"尚未扫描磁盘，请先扫描建立文件清单"}</Text><Group><Button variant="default" loading={busy} onClick={()=>void scan()}>扫描 / 刷新文件</Button>{busy?<Button variant="subtle" onClick={()=>abort.current?.abort()}>停止扫描</Button>:null}</Group></Group>
    {progress?<Text size="sm" mt="md" role="status">{progress}</Text>:null}{error?<Alert color="red" mt="md">{error}</Alert>:null}
    {data?<>{data.diskFreeBytes!=null?<Text size="xs" c="dimmed" mt="md">所在磁盘可用 {bytes(data.diskFreeBytes)}；下方统计范围为应用托管文件、后台版本和快照。</Text>:null}<dl className={styles.summary}>{[["逻辑文件大小",bytes(data.logicalBytes)],["分配空间估算",bytes(data.allocatedBytes)],["硬链接节省",bytes(data.hardlinkSavedBytes)],["可清理文件",String(data.orphanCount)],["缺失文件",String(data.missingCount)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {data.warnings.length?<details><summary>扫描范围说明（{data.warnings.length} 项）</summary>{data.warnings.map((message,index)=><Text size="xs" key={index}>{message}</Text>)}</details>:null}
    <Group className={styles.toolbar}><TextInput aria-label="搜索文件或引用" placeholder="搜索文件、版本或组件" value={search} onChange={event=>setSearch(event.currentTarget.value)} onKeyDown={event=>{if(event.key==="Enter")void load();}}/><Button variant="default" onClick={()=>void load()} disabled={busy}>搜索</Button><Button variant="light" color="red" disabled={busy||!data.items.some(item=>item.canCleanup)} onClick={()=>void cleanup(data.items.filter(item=>item.canCleanup).map(item=>item.id))}>清理本页未引用文件</Button></Group>
    <DataTable minWidth={820}><Table.Thead><Table.Tr>{["文件","占用","引用与状态","操作"].map(label=><Table.Th key={label}>{label}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{data.items.map(item=><Table.Tr key={item.id}><Table.Td className={styles.name}><Text size="sm">{item.name}</Text><Text size="xs" c="dimmed">{item.category}{item.links>1?` · ${item.links} 个硬链接`:""}</Text></Table.Td><Table.Td>{bytes(item.sizeBytes)}</Table.Td><Table.Td><Text size="sm" c={item.state==="missing"?"red":item.canCleanup?"orange":"dimmed"}>{states[item.state]}</Text>{item.references.map((ref,index)=><Text size="xs" key={index}>{ref}</Text>)}</Table.Td><Table.Td>{item.canCleanup?<Button size="compact-xs" variant="subtle" color="red" disabled={busy} onClick={()=>void cleanup([item.id])}>清理</Button>:<Text size="xs" c="dimmed">{item.state==="missing"?"请在所属版本重新获取":"由所属版本管理"}</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></DataTable>
    <Group justify="flex-end" mt="md"><Button variant="default" disabled={page===0||busy} onClick={()=>void load(page-1)}>上一页</Button><Text size="sm">第 {page+1} 页</Text><Button variant="default" disabled={!data.hasMore||busy} onClick={()=>void load(page+1)}>下一页</Button></Group>
    <details className={styles.jobs} open={data.cleanupJobs.some(job=>job.lastError)}><summary>待清理 / 失败任务（{data.cleanupTotal}）</summary>{data.cleanupJobs.map(job=><div key={job.id}><Text size="sm">{job.reason}</Text><Text size="xs" className={styles.name}>{job.path}</Text><Group justify="space-between"><Text size="xs" c={job.lastError?"red":"dimmed"}>{job.lastError||"等待后台清理"} · 已尝试 {job.attempts} 次</Text><Button size="compact-xs" variant="default" disabled={busy||job.blocked} onClick={()=>void retry(job.id)}>{job.blocked?"需人工核对":"立即重试"}</Button></Group></div>)}{data.cleanupJobs.length<data.cleanupTotal?<Button size="compact-xs" variant="default" disabled={busy} onClick={()=>void moreJobs()}>加载更多清理任务</Button>:null}</details></>:null}
    <Button size="compact-xs" variant="subtle" mt="md" onClick={()=>{onClose();onOpenAttachments();}}>管理图床附件</Button>
    <Text size="xs" c="dimmed" mt="md">图床附件在“附件与图床”管理；后台版本与数据库快照按既有回滚策略保留。未引用文件需超过 24 小时才可清理；缺失文件不会被误报为已释放空间。</Text>
  </div></Modal>;
}
