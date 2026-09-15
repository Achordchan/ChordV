import { useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { request } from "../../api/base";
import type { ComponentVersion } from "../../api/runtime-versions";
import { useActionConfirmation } from "../modals/useActionConfirmation";
import styles from "./ComponentDelivery.module.css";

type HistoryVersion = ComponentVersion & { active: boolean; canDelete: boolean };
export function ComponentHistory({componentId,onChanged}:{componentId:string;onChanged:()=>void}) {
  const [items,setItems]=useState<HistoryVersion[]|null>(null), [page,setPage]=useState(0), [more,setMore]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState("");
  const confirmation=useActionConfirmation(true);
  const load=async(next=0)=>{
    setBusy(true);setError("");
    try{const result=await request<{items:HistoryVersion[];hasMore:boolean}>(`/admin/runtime-versions/${encodeURIComponent(componentId)}/history?page=${next}`);setItems(current=>next?[...new Map([...(current||[]),...result.items].map(item=>[item.id,item])).values()]:result.items);setPage(next);setMore(result.hasMore);}
    catch(reason){setError(reason instanceof Error?reason.message:"读取历史失败");}finally{setBusy(false);}
  };
  const act=async(item:HistoryVersion,remove:boolean)=>{
    if(!await confirmation.confirm({title:remove?"删除历史文件":"使用已保存版本",message:remove?"删除这条非使用版本，文件将进入可重试清理队列。":`直接使用已保存的 ${item.versionLabel||item.requestedVersion}，不会重新下载。`,confirmLabel:remove?"确认删除":"启用此版本",danger:remove}))return;
    setBusy(true);setError("");
    try{await request(`/admin/runtime-versions/${encodeURIComponent(item.id)}${remove?"":"/activate"}`,{method:remove?"DELETE":"POST"});await load();onChanged();}
    catch(reason){setError(reason instanceof Error?reason.message:"操作失败");}finally{setBusy(false);}
  };
  return <>{confirmation.dialog}<details className={styles.details} onToggle={event=>{if(event.currentTarget.open&&!busy)void load();}}><summary>已保存的历史文件</summary>
    <Button size="compact-xs" variant="subtle" disabled={busy} onClick={()=>void load()}>刷新历史</Button>
    {error?<Text size="xs" c="red">{error}</Text>:null}
    {items?.map(item=><div key={item.id} style={{padding:"10px 0",borderBottom:"1px solid #e4e9df"}}><Text size="sm">{item.versionLabel||item.requestedVersion||"未解析版本"}{item.active?" · 当前使用":""}</Text><Text size="xs" c="dimmed">{item.fileSizeBytes?`${(Number(item.fileSizeBytes)/1048576).toFixed(1)} MB · `:""}{item.status==="ready"?"文件已保存":item.status==="failed"?"获取失败":item.status==="unchanged"?"内容未变化":item.status==="queued"?"等待获取":item.status==="downloading"?"下载中":item.status==="verifying"?"校验中":item.status}</Text>
    {item.retainUntil&&!item.active?<Text size="xs" c="dimmed">兼容保留至 {new Date(item.retainUntil).toLocaleDateString("zh-CN")}</Text>:null}
    <Group gap="xs" mt={5}>{item.status==="ready"&&!item.active?<Button size="compact-xs" variant="light" disabled={busy} onClick={()=>void act(item,false)}>使用此版本</Button>:null}{item.canDelete?<Button size="compact-xs" variant="subtle" color="red" disabled={busy} onClick={()=>void act(item,true)}>删除文件</Button>:null}</Group></div>)}
    {items?.length===0?<Text size="xs" c="dimmed">暂无历史文件</Text>:null}
    <Text size="xs" c="dimmed" mt={8}>当前使用和获取中的版本不可删除；曾分发的文件在切换后保留 30 天。</Text>
    {more||error?<Button size="compact-xs" variant="default" loading={busy} onClick={()=>void load(error?0:page+1)}>{error?"重新读取":"加载更早版本"}</Button>:busy?<Text size="xs">正在读取…</Text>:null}
  </details></>;
}
