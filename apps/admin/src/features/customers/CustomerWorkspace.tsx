import { CustomerRoutingRules } from "./CustomerRoutingRules";
import { useMemo, useState } from "react";
import { Alert, Avatar, Button, Group, Menu, Stack, Tabs, Text, TextInput } from "@mantine/core";
import { IconAlertCircle, IconArrowLeft, IconChevronDown, IconGaugeOff, IconLock, IconLockOpen2, IconPencil, IconPlugConnectedX, IconSearch, IconUsers } from "@tabler/icons-react";
import { formatDateTime } from "../../utils/admin-format";
import { getRenewActionText, subscriptionStateColor, translateRole, translateSubscriptionState } from "../../utils/admin-translate";
import { customerNotice, personalCustomer, teamCustomer, type CustomerRecord } from "./customer-model";
import { CustomerSubscription } from "./CustomerSubscription";
import { CustomerNodes } from "./CustomerNodes";
import { CustomerMembers } from "./CustomerMembers";
import { CustomerActivity, customerTasks } from "./CustomerActivity";
import { TeamProfileEditorPanel } from "./TeamEditors";
import type { UsersPageProps } from "./types";
import styles from "./CustomerWorkspace.module.css";

type DetailTab = "rights" | "nodes" | "members" | "profile" | "activity" | "routing";

export function CustomerWorkspace(props: UsersPageProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const rows = useMemo(() => {
    const byId = new Map(props.allSubscriptions.map(subscription => [subscription.id, subscription]));
    const byUser = new Map(props.allSubscriptions.filter(subscription => subscription.ownerType === "user" && subscription.userId).map(subscription => [subscription.userId!, subscription]));
    return props.userTab === "personal"
      ? props.users.filter(user => user.accountType === "personal").map(user => personalCustomer(user, byId, byUser))
      : props.filteredTeams.map(team => teamCustomer(team, byId));
  }, [props.allSubscriptions, props.users, props.filteredTeams, props.userTab]);
  // Selection is resolved from the current authoritative list, so deletion,
  // filtering and refreshed records cannot leave an actionable stale customer.
  const selected = rows.find(customer => customer.key === selectedKey) ?? rows[0] ?? null;
  const switchType = (type: "personal" | "team") => {
    setSelectedKey(null); setMobileDetail(false); props.onSearchChange(""); props.onUserTabChange(type);
  };
  return <div className={`${styles.workspace} ${mobileDetail && selected ? styles.detailOpen : ""}`}>
    <aside className={styles.sidebar} aria-label="客户列表">
      <div className={styles.sidebarTools}>
        <h2>{props.userTab === "personal" ? "客户" : "团队"}<span>{rows.length}</span></h2>
        <TextInput aria-label="搜索客户与团队" placeholder={props.userTab === "personal" ? "搜索姓名或邮箱" : "搜索团队或负责人"} leftSection={<IconSearch size={18}/>} value={props.searchValue}
          onChange={event => props.onSearchChange(event.currentTarget.value)} classNames={{ input: styles.searchInput }}/>
        <div className={styles.segmented} aria-label="客户类型">
          <button aria-pressed={props.userTab === "personal"} onClick={() => switchType("personal")}>个人</button>
          <button aria-pressed={props.userTab === "team"} onClick={() => switchType("team")}>团队</button>
        </div>
      </div>
      <div className={styles.customerList}>{rows.map(customer => <button key={customer.key} className={`${styles.customerRow} ${selected?.key === customer.key ? styles.selected : ""}`}
        aria-pressed={selected?.key === customer.key} onClick={() => { setSelectedKey(customer.key); setMobileDetail(true); }}>
        <Avatar size={44} radius="xl" color="#1c4d37" className={styles.listAvatar}>{Array.from(customer.name)[0]}</Avatar>
        <span className={styles.rowIdentity}><strong>{customer.name}</strong><small title={customer.email}>{customer.email}</small>{!customer.enabled && <small className={styles.disabledLabel}>{customer.team ? "团队已停用" : "账号已停用"}</small>}</span>
        <span className={styles.rowState}><span style={{ color: customer.summary?.state === "active" ? "#427653" : customer.summary?.state === "expired" || customer.summary?.state === "exhausted" ? "#b22c40" : "#858578" }}>
          {customer.summary ? translateSubscriptionState(customer.summary.state) : "未开通"}</span>
          <small>{customer.summary ? `${new Date(customer.summary.expireAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} 到期` : "暂无订阅"}</small>
        </span>
      </button>)}</div>
      {!rows.length && <div className={styles.listEmpty}><IconSearch size={26}/><Text fw={600}>{props.searchValue ? "没有匹配的客户" : props.userTab === "team" ? "暂无团队" : "暂无个人客户"}</Text>
        {props.searchValue && <button className={styles.textButton} onClick={() => props.onSearchChange("")}>清除搜索</button>}</div>}
    </aside>
    <main className={styles.detail}>{selected ? <CustomerDetail key={selected.key} customer={selected} actions={props} onBack={() => setMobileDetail(false)}/>
      : <div className={styles.empty}><IconUsers size={32}/><h2>{props.searchValue ? "没有符合条件的客户" : "客户与订阅"}</h2><p>{props.searchValue ? "调整搜索条件后查看客户详情。" : "客户与团队将在这里展示，选择后管理订阅权益。"}</p></div>}
    </main>
  </div>;
}

function CustomerDetail({ customer, actions, onBack }: { customer: CustomerRecord; actions: UsersPageProps; onBack: () => void }) {
  const [tab, setTab] = useState<DetailTab>("rights");
  const subscription = customer.subscription ?? customer.summary;
  const ownerLabel = `${customer.name} · ${subscription?.planName ?? "未开通订阅"}`;
  const notice = customerNotice(customer);
  const { hasTasks } = customerTasks(customer, actions);
  const create = () => customer.user ? actions.onCreateSubscriptionForUser(customer.user) : customer.team && actions.onOpenTeamSubscriptions(customer.team);
  const manageNodes = () => subscription && actions.onOpenNodeAccessEditor(subscription.id, ownerLabel);
  const tabs: Array<{ id: DetailTab; label: string }> = [{ id: "rights", label: "订阅权益" }, { id: "nodes", label: "节点授权" },
    ...(customer.team ? [{ id: "members" as const, label: "团队成员" }] : [{ id: "routing" as const, label: "自定义规则" }]), { id: "profile", label: customer.team ? "团队资料" : "账号资料" }, { id: "activity", label: "执行状态" }];
  return <>
    <button className={styles.backButton} onClick={onBack}><IconArrowLeft size={17}/>返回列表</button>
    <header className={styles.identityHeader}><div className={styles.identity}>
      <Avatar size={96} radius="xl" color="#1c4d37" className={styles.heroAvatar}>{Array.from(customer.name)[0]}</Avatar>
      <div><h1>{customer.name}</h1><p>{customer.email}</p><span className={`${styles.accountState} ${customer.enabled ? styles.enabled : ""}`}><span/>{customer.team ? "团队" : "账号"}{customer.enabled ? "已启用" : "已停用"}</span></div>
    </div><Group gap="sm" className={styles.headerActions}>
      <Button color="#1c4d37" size="md" disabled={Boolean(subscription && customer.subscription?.renewable === false)} onClick={() => subscription ? actions.onOpenRenewDrawer(subscription.id) : create()}>
        {subscription ? customer.subscription ? getRenewActionText(customer.subscription.renewable) : "续期" : "开通订阅"}
      </Button>
      <Menu position="bottom-end" shadow="sm" withinPortal><Menu.Target><Button variant="default" size="md" rightSection={<IconChevronDown size={16}/>}>更多</Button></Menu.Target><Menu.Dropdown>
        <Menu.Item leftSection={<IconPencil size={16}/>} onClick={() => { if (customer.user) actions.onOpenUserDrawer(customer.user.id); else { setTab("profile"); actions.onOpenTeamInlineEditor(customer.team!.id); } }}>{customer.team ? "编辑团队" : "编辑账号"}</Menu.Item>
        {customer.team && <Menu.Item leftSection={<IconUsers size={16}/>} onClick={() => { setTab("members"); actions.onOpenTeamMemberInlineEditor(customer.team!.id); }}>添加成员</Menu.Item>}
        {customer.user && <><Menu.Item leftSection={<IconPlugConnectedX size={16}/>} disabled={actions.actionBusyKey !== null} onClick={() => actions.onDisconnectUser(customer.user!.id, customer.name, "personal")}>断开连接</Menu.Item>
          <Menu.Item color={customer.enabled ? "red" : "green"} leftSection={customer.enabled ? <IconLock size={16}/> : <IconLockOpen2 size={16}/>} disabled={actions.actionBusyKey !== null}
            onClick={() => actions.onToggleUserStatus(customer.user!.id, customer.enabled ? "disabled" : "active", customer.name)}>{customer.enabled ? "禁用账号" : "启用账号"}</Menu.Item></>}
        {subscription && <><Menu.Divider/><Menu.Item color="orange" leftSection={<IconGaugeOff size={16}/>} disabled={actions.resetTrafficBusyKey !== null}
          onClick={() => actions.onResetSubscriptionTraffic(subscription.id, customer.name)}>重置流量</Menu.Item></>}
      </Menu.Dropdown></Menu>
    </Group></header>
    {notice && <Alert icon={<IconAlertCircle size={20}/>} color="yellow" className={styles.notice}>{notice}</Alert>}
    {hasTasks && <button className={styles.taskNotice} onClick={() => setTab("activity")}><IconAlertCircle size={16}/><span>有操作尚未完成下发</span><strong>查看执行状态</strong></button>}
    <Tabs value={tab} onChange={value => { if (value) setTab(value as DetailTab); }} keepMounted={false}>
    <Tabs.List className={styles.tabs} aria-label="客户详情">{tabs.map(item => <Tabs.Tab key={item.id} value={item.id}>{item.label}</Tabs.Tab>)}</Tabs.List>
    <Tabs.Panel className={styles.surface} value={tab}>
      {tab === "rights" && <CustomerSubscription customer={customer} actions={actions}/>}
      {tab === "nodes" && (customer.subscription ? <CustomerNodes subscription={customer.subscription} onManage={manageNodes}/>
        : <div className={styles.empty}><p>{subscription ? "订阅详情尚未同步，可打开授权管理查看。" : "请先开通订阅，再分配节点。"}</p><Button color="#1c4d37" onClick={subscription ? manageNodes : create}>{subscription ? "管理授权" : "开通订阅"}</Button></div>)}
      {tab === "members" && customer.team && <CustomerMembers team={customer.team} actions={actions}/>}
      {tab === "routing" && customer.user && <CustomerRoutingRules key={customer.user.id} userId={customer.user.id}/>}
      {tab === "profile" && <CustomerProfile customer={customer} actions={actions}/>}
      {tab === "activity" && <CustomerActivity customer={customer} actions={actions}/>}
    </Tabs.Panel>
    </Tabs>
  </>;
}

function CustomerProfile({ customer, actions }: { customer: CustomerRecord; actions: UsersPageProps }) {
  return <Stack gap="lg"><div className={styles.sectionHeading}><div><h2>{customer.team ? "团队资料" : "账号资料"}</h2><p className={styles.muted}>身份资料与订阅权益分别管理</p></div>
    <Button variant="default" leftSection={<IconPencil size={16}/>} onClick={() => customer.user ? actions.onOpenUserDrawer(customer.user.id) : actions.onOpenTeamInlineEditor(customer.team!.id)}>编辑资料</Button></div>
    <dl className={styles.profileFacts}><div><dt>名称</dt><dd>{customer.name}</dd></div><div><dt>{customer.team ? "负责人邮箱" : "邮箱"}</dt><dd>{customer.email}</dd></div>
      <div><dt>状态</dt><dd>{customer.enabled ? "已启用" : "已停用"}</dd></div>
      {customer.user && <><div><dt>账号角色</dt><dd>{translateRole(customer.user.role)}</dd></div><div><dt>订阅数量</dt><dd>{customer.user.subscriptionCount}</dd></div></>}
      {customer.team && <><div><dt>负责人</dt><dd>{customer.team.ownerDisplayName}</dd></div><div><dt>团队成员</dt><dd>{customer.team.memberCount} 人</dd></div><div><dt>创建时间</dt><dd>{formatDateTime(customer.team.createdAt)}</dd></div></>}
    </dl>
    {customer.team && actions.teamInlineEditorId === customer.team.id && <TeamProfileEditorPanel {...actions} team={customer.team}/>}
  </Stack>;
}
