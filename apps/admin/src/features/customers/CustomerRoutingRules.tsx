import { useEffect, useState } from "react";
import { Button, Group, Table, Text } from "@mantine/core";
import type { ClientRoutingRuleDto } from "@chordv/shared";
import { request } from "../../api/base";
import { subscribeAdminRuntimeEvents } from "../../api/client";
import { readError } from "../../utils/admin-filters";
import { DataSkeleton } from "../shared/DataSkeleton";
import styles from "./CustomerRoutingRules.module.css";

export function CustomerRoutingRules({userId}:{userId:string}) {
  const [rules,setRules]=useState<ClientRoutingRuleDto[]|null>(null);
  const [error,setError]=useState("");
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let active=true, busy=false, dirty=false;
    setRules(null);setError("");
    const load=async()=>{
      if(busy){dirty=true;return;}busy=true;
      try{const data=await request<ClientRoutingRuleDto[]>(`/admin/users/${encodeURIComponent(userId)}/routing-rules`);
        if(data.some(rule=>rule.userId!==userId))throw new Error("规则归属与当前客户不一致");
        if(active){setRules(data);setError("");}
      }catch(reason){if(active)setError(readError(reason,"自定义规则读取失败"));}
      finally{busy=false;if(active&&dirty){dirty=false;void load();}}
    };
    void load();
    const stop=subscribeAdminRuntimeEvents(event=>{if(event.type==="policy_updated"||(event.type==="node_access_updated"&&!event.nodeId))void load();});
    return()=>{active=false;stop();};
  },[userId,refresh]);
  return <section className={styles.root}>
    <Group justify="space-between" mb="sm"><h3>自定义规则</h3><Text size="sm" c="dimmed">{rules?`${rules.length} 条 · 只读`:"只读"}</Text></Group>
    <Text size="sm" c="dimmed" mb="lg">账号在客户端保存的规则，仅规则模式生效，优先于系统分流规则。此处显示配置，不代表当前连接已应用。</Text>
    {error?<div role="alert" className={styles.error}><Text size="sm">{error}{rules?" 下方保留上次读取结果。":""}</Text><Button variant="subtle" color="red.8" onClick={()=>setRefresh(value=>value+1)}>重新读取</Button></div>:null}
    {!rules&&!error?<DataSkeleton rows={4}/>:rules?.length?<Table.ScrollContainer minWidth={560}><Table className={styles.table}><Table.Thead><Table.Tr><Table.Th>匹配内容</Table.Th><Table.Th>匹配方式</Table.Th><Table.Th>连接方式</Table.Th><Table.Th>状态</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{rules.map(rule=><Table.Tr key={rule.id}>
      <Table.Td><Text size="sm" fw={550} className={styles.value}>{rule.value}</Text>{rule.name?<Text size="xs" c="dimmed">{rule.name}</Text>:null}</Table.Td>
      <Table.Td>{rule.matchType==="domain"?"域名及子域名":"关键词"}</Table.Td>
      <Table.Td>{rule.action==="proxy"?"走代理":"直连"}</Table.Td>
      <Table.Td><Text size="sm" c={rule.enabled?"teal.9":"dimmed"}>{rule.enabled?"已启用":"已停用"}</Text></Table.Td>
    </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>:rules?<Text className={styles.empty}>该账号尚未保存自定义规则</Text>:null}
  </section>;
}
