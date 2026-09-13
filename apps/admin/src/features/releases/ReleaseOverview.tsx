import { Fragment, useState } from "react";
import { ActionIcon, Button, Group, Menu, SegmentedControl, Table, Text, TextInput } from "@mantine/core";
import { IconBrandAndroid, IconBrandApple, IconBrandWindows, IconDeviceMobile, IconDots, IconLink, IconPlus, IconSearch } from "@tabler/icons-react";
import type { AdminReleaseRecordDto, AdminReleasePlatform, AdminReleaseArtifactRecordDto } from "../../api/client";
import { releasePlatformOptions } from "./types";
import { DataTable } from "../shared/DataTable";
import { formatDateTime } from "../../utils/admin-format";
import styles from "./ReleaseWorkspace.module.css";

type Props = {
  records: AdminReleaseRecordDto[]; allRecords: AdminReleaseRecordDto[];
  search: string; onSearch: (value:string)=>void;
  platform: AdminReleasePlatform | "all"; onPlatform: (value:AdminReleasePlatform | "all")=>void;
  busy: boolean; onCreate: ()=>void; onEdit:(record:AdminReleaseRecordDto)=>void;
  onPublish:(record:AdminReleaseRecordDto)=>void; onWithdraw:(record:AdminReleaseRecordDto)=>void; onDelete:(record:AdminReleaseRecordDto)=>void;
  onAdd:(record:AdminReleaseRecordDto)=>void; onEditArtifact:(releaseId:string,artifact:AdminReleaseArtifactRecordDto)=>void;
  onDeleteArtifact:(releaseId:string,artifactId:string)=>void; onCopy:(url:string)=>void;
};
export function PlatformIcon({platform}:{platform:AdminReleasePlatform}) {
  const Icon = platform === "windows" ? IconBrandWindows : platform === "android" ? IconBrandAndroid : platform === "ios" ? IconDeviceMobile : IconBrandApple;
  return <Icon size={30} stroke={1.5}/>;
}
export function ReleaseOverview(p:Props) {
  const [status,setStatus]=useState("all"), [expanded,setExpanded]=useState<string|null>(null);
  const records=p.records.filter(r=>status==="all"||r.status===status);
  return <section className={styles.overview}>
    <div className={styles.topActions}><Text c="dimmed" size="sm">客户端版本与安装包</Text><Button color="teal.9" leftSection={<IconPlus size={16}/>} onClick={p.onCreate} disabled={p.busy}>新建发布</Button></div>
    <div className={styles.platforms}>{releasePlatformOptions.map(platform=>{
      const published=p.allRecords.filter(r=>r.platform===platform.value&&r.status==="published"&&(!r.publishedAt||Date.parse(r.publishedAt)<=Date.now()));
      return <button key={platform.value} className={styles.platform} onClick={()=>p.onPlatform(p.platform===platform.value ? "all" : platform.value)} aria-pressed={p.platform===platform.value}><PlatformIcon platform={platform.value}/><div><strong>{platform.label}</strong><small>{published.length?`${published.length} 个已发布版本`:"尚未发布"}</small></div></button>;
    })}</div>
    <div className={styles.toolbar}><TextInput placeholder="搜索版本或标题" aria-label="搜索发布" leftSection={<IconSearch size={16}/>} value={p.search} onChange={e=>p.onSearch(e.currentTarget.value)}/><SegmentedControl aria-label="发布状态筛选" classNames={{root: styles.statusFilter, label: styles.statusLabel, indicator: styles.statusIndicator}} value={status} onChange={setStatus} data={[{value:"all",label:"全部"},{value:"draft",label:"草稿"},{value:"published",label:"已发布"},{value:"archived",label:"已归档"}]}/></div>
    <div className={styles.table}><DataTable minWidth={900}><Table.Thead><Table.Tr>{["版本与平台","安装包","状态","更新时间","操作"].map(t=><Table.Th key={t}>{t}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{records.length?records.map(r=><Fragment key={r.id}><Table.Tr>
      <Table.Td><div className={styles.version}><PlatformIcon platform={r.platform}/><div><button className={styles.textButton} onClick={()=>setExpanded(expanded===r.id?null:r.id)} aria-expanded={expanded===r.id}>{releasePlatformOptions.find(x=>x.value===r.platform)?.label} {r.version}</button><Text size="xs" c="dimmed" mt={5}>{r.title}</Text></div></div></Table.Td>
      <Table.Td><Text size="sm" c={r.artifacts.length?undefined:"orange"}>{r.artifacts.length?`${r.artifacts.length} 个安装包`:"待添加安装包"}</Text>{r.artifacts.length>0?<Text size="xs" c="dimmed" mt={5}>{r.artifacts.some(a=>a.source==="external")?"外链分发":"本地文件"}</Text>:null}</Table.Td>
      <Table.Td><Text size="sm" c={r.status==="published"?"teal.9":r.status==="draft"?"orange":"dimmed"}>{r.status==="published"?"已发布":r.status==="draft"?"草稿":"已归档"}</Text></Table.Td>
      <Table.Td><Text size="sm" c="dimmed">{(r.updatedAt||r.publishedAt||r.createdAt ? formatDateTime((r.updatedAt||r.publishedAt||r.createdAt)!) : "—")}</Text></Table.Td>
      <Table.Td><Group gap="xs" wrap="nowrap">{r.status==="draft"?<Button size="xs" color="teal.9" variant={r.artifacts.length?"light":"filled"} disabled={p.busy} onClick={()=>r.artifacts.length?p.onPublish(r):p.onAdd(r)}>{r.artifacts.length?"发布版本":"添加外链"}</Button>:null}<Menu withinPortal position="bottom-end"><Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="发布操作" disabled={p.busy}><IconDots size={17}/></ActionIcon></Menu.Target><Menu.Dropdown><Menu.Item onClick={()=>setExpanded(expanded===r.id?null:r.id)}>查看详情</Menu.Item>{r.status!=="archived"?<><Menu.Item onClick={()=>p.onEdit(r)}>编辑版本信息</Menu.Item>{r.status==="draft"?<Menu.Item onClick={()=>p.onAdd(r)}>管理安装包 / 添加外链</Menu.Item>:<Menu.Item onClick={()=>p.onWithdraw(r)}>撤回为草稿</Menu.Item>}<Menu.Item color="red" onClick={()=>p.onDelete(r)}>删除发布</Menu.Item></>:null}</Menu.Dropdown></Menu></Group></Table.Td>
    </Table.Tr>{expanded===r.id?<Table.Tr><Table.Td colSpan={5}><div className={styles.expanded}><section><h3>更新说明</h3>{r.changelog.length?<ul>{r.changelog.map((line,i)=><li key={i}>{line}</li>)}</ul>:<Text size="sm" c="dimmed">尚未填写更新说明</Text>}</section><section><h3>安装包</h3>{r.artifacts.map(a=><div key={a.id} className={styles.artifact}><Group justify="space-between"><div><Text size="sm" fw={550}>{a.fileName||"外链安装包"}</Text><Text size="xs" c="dimmed">{a.source==="external"?"外部链接":"已上传"} · {a.type.toUpperCase()}{a.isPrimary?" · 更新入口":""}</Text></div><Group gap="xs"><Button variant="subtle" size="xs" onClick={()=>p.onCopy(a.downloadUrl)} leftSection={<IconLink size={14}/>}>复制地址</Button>{r.status==="draft"?<><Button variant="subtle" size="xs" disabled={p.busy} onClick={()=>p.onEditArtifact(r.id,a)}>编辑</Button><Button variant="subtle" color="red" size="xs" disabled={p.busy} onClick={()=>p.onDeleteArtifact(r.id,a.id)}>删除</Button></>:null}</Group></Group><details><summary>地址与校验信息</summary><p>{a.downloadUrl}</p><p>文件大小：{a.fileSizeBytes||"未填写"} 字节</p><p>SHA256：{a.fileHash||"未填写"}</p></details></div>)}{!r.artifacts.length?<Text size="sm" c="dimmed">草稿已保存，可以继续添加外链或上传文件。</Text>:null}</section></div></Table.Td></Table.Tr>:null}</Fragment>):<Table.Tr><Table.Td colSpan={5}><Text ta="center" c="dimmed" py="xl">没有符合条件的发布记录</Text></Table.Td></Table.Tr>}</Table.Tbody></DataTable></div>
  </section>;
}
