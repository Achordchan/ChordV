import { useState } from "react";
import { Badge, Button, SegmentedControl, Text, TextInput } from "@mantine/core";
import type { AdminPlanRecordDto, PlanScope } from "@chordv/shared";
import { IconArrowLeft, IconListDetails, IconPencil, IconSearch } from "@tabler/icons-react";
import { formatDateTimeWithYear, formatTrafficGb } from "../utils/admin-format";
import styles from "../features/plans/PlansPage.module.css";

type PlansPageProps = {
  searchValue: string; onSearchChange: (value: string) => void;
  planScopeTab: PlanScope; onPlanScopeTabChange: (value: PlanScope) => void;
  plans: AdminPlanRecordDto[]; onOpenPlanDrawer: (planId: string) => void;
};

export function PlansPage(props: PlansPageProps) {
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const personalPlans = props.plans.filter(item => item.scope === "personal");
  const teamPlans = props.plans.filter(item => item.scope === "team");
  const scoped = props.planScopeTab === "personal" ? personalPlans : teamPlans;
  const currentPlans = scoped.filter(item => status === "all" || item.isActive === (status === "active"));
  const selected = currentPlans.find(item => item.id === selectedId) ?? currentPlans[0] ?? null;
  const chooseScope = (scope: PlanScope) => { props.onPlanScopeTabChange(scope); setSelectedId(null); setDetailOpen(false); };
  return <section className={`${styles.page} ${detailOpen && selected ? styles.detailOpen : ""}`} aria-label="套餐规则">
    <aside className={styles.sidebar} aria-label="套餐列表">
      <div className={styles.tools}><h2>套餐 <span>{currentPlans.length}</span></h2>
        <TextInput aria-label="搜索套餐名称" placeholder="搜索套餐名称" leftSection={<IconSearch size={17}/>} value={props.searchValue} onChange={event => props.onSearchChange(event.currentTarget.value)}/>
        <div className={styles.scopes}><button aria-pressed={props.planScopeTab === "personal"} onClick={() => chooseScope("personal")}>个人套餐 <span>{personalPlans.length}</span></button><button aria-pressed={props.planScopeTab === "team"} onClick={() => chooseScope("team")}>团队套餐 <span>{teamPlans.length}</span></button></div>
        <SegmentedControl aria-label="套餐状态" fullWidth value={status} onChange={setStatus}
          classNames={{ root: styles.statusFilter, indicator: styles.statusIndicator, label: styles.statusLabel, control: styles.statusControl }}
          data={[{ value: "all", label: "全部" }, { value: "active", label: "已启用" }, { value: "disabled", label: "已停用" }]}/>
      </div>
      <div className={styles.list}>{currentPlans.map(item => <button key={item.id} className={styles.item} aria-pressed={selected?.id === item.id} onClick={() => { setSelectedId(item.id); setDetailOpen(true); }}>
        <span><strong>{item.name}</strong><small>{formatTrafficGb(item.totalTrafficGb)} GB · {item.maxConcurrentSessions} 个并发会话</small></span><span className={item.isActive ? styles.enabled : styles.muted}>{item.isActive ? "已启用" : "已停用"}</span>
      </button>)}</div>
      {!currentPlans.length && <div className={styles.empty}><IconSearch size={24}/><Text size="sm">没有符合条件的套餐</Text>{(props.searchValue || status !== "all") && <Button variant="subtle" color="#1c4d37" onClick={() => { props.onSearchChange(""); setStatus("all"); }}>清除筛选</Button>}</div>}
    </aside>
    <div className={styles.detail}>{selected ? <>
      <button className={styles.back} onClick={() => setDetailOpen(false)}><IconArrowLeft size={16}/>返回套餐列表</button>
      <header className={styles.header}><div><Text size="xs" c="dimmed" mb={8}>{selected.scope === "team" ? "团队共享套餐" : "个人套餐"}</Text><h1>{selected.name}</h1><Badge mt="sm" variant="light" color={selected.isActive ? "#3e7150" : "gray"}>{selected.isActive ? "已启用" : "已停用"}</Badge></div>
        <Button color="#1c4d37" leftSection={<IconPencil size={16}/>} onClick={() => props.onOpenPlanDrawer(selected.id)} title="编辑套餐" aria-label={`编辑套餐 ${selected.name}`}>编辑套餐</Button></header>
      <section className={styles.surface}><h2>套餐权益</h2><div className={styles.entitlements}>
        <div><small>默认流量额度</small><strong>{formatTrafficGb(selected.totalTrafficGb)}<span>GB</span></strong></div>
        <div><small>最大并发会话</small><strong>{selected.maxConcurrentSessions}<span>个</span></strong></div>
      </div><p className={styles.explanation}>具体订阅的剩余流量与到期日，在客户详情中管理。</p>
      <div className={styles.rules}><section><h2>使用规则</h2><dl><div><dt>适用对象</dt><dd>{selected.scope === "team" ? "团队共享" : "个人客户"}</dd></div><div><dt>续期规则</dt><dd>{selected.renewable ? "允许续期" : "不支持续期"}</dd></div><div><dt>新开通选择</dt><dd>{selected.isActive ? "可选择此套餐" : "已停止提供"}</dd></div></dl></section>
        <section><h2>使用与维护</h2><dl><div><dt>关联订阅</dt><dd>{selected.subscriptionCount} 个</dd></div><div><dt>创建时间</dt><dd>{formatDateTimeWithYear(selected.createdAt)}</dd></div><div><dt>最后更新</dt><dd>{formatDateTimeWithYear(selected.updatedAt)}</dd></div></dl></section></div>
      </section>
      <p className={styles.impact}>{selected.subscriptionCount > 0 ? `此套餐已关联 ${selected.subscriptionCount} 个订阅，修改并发上限可能影响已有连接。` : "此套餐尚未关联订阅，可编辑规则后用于新开通。"}</p>
    </> : <div className={styles.empty}><IconListDetails size={32}/><h2>{props.searchValue || status !== "all" ? "没有匹配套餐" : "暂无此类套餐"}</h2><p>{props.searchValue || status !== "all" ? "调整左侧搜索或筛选条件。" : "通过右上方“新建套餐”定义第一份规则。"}</p></div>}</div>
  </section>;
}
