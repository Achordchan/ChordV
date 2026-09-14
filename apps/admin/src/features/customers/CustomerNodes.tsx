import { DataSkeleton } from "../shared/DataSkeleton";
import { useEffect, useState } from "react";
import { Button, Stack, Text } from "@mantine/core";
import { CountryFlag } from "../../components/CountryFlag";
import { resolveCountryCode } from "@chordv/shared";
import type { AdminSubscriptionRecordDto, SubscriptionNodeAccessDto } from "@chordv/shared";
import { getSubscriptionNodeAccess } from "../../api/subscriptions";
import { summarizeAdminDiagnosticMessage } from "../../utils/admin-filters";
import styles from "./CustomerWorkspace.module.css";

export function CustomerNodes({ subscription, compact = false, onManage }: {
  subscription: AdminSubscriptionRecordDto; compact?: boolean; onManage: () => void;
}) {
  const [data, setData] = useState<SubscriptionNodeAccessDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void getSubscriptionNodeAccess(subscription.id).then(value => {
      if (!active) return;
      if (value.subscriptionId !== subscription.id) throw new Error("节点授权结果与当前订阅不一致");
      setData(value);
    }).catch(reason => {
      if (active) setError(summarizeAdminDiagnosticMessage(reason instanceof Error ? reason.message : String(reason), "节点授权加载失败") ?? "节点授权加载失败");
    }).finally(() => { if (active) setLoading(false); });
    // A new authoritative subscription record follows mutations or snapshot
    // refreshes. Ignore late responses from the previously selected customer.
    return () => { active = false; };
  }, [subscription, retry]);
  const currentData = data?.subscriptionId === subscription.id ? data : null;
  return <section>
    <div className={styles.sectionHeading}><h3>已授权节点</h3><button className={styles.textButton} onClick={onManage}>管理授权</button></div>
    {error && currentData && <Stack gap="xs"><Text size="sm" c="red">{error}，下方保留上次读取结果。</Text><Button size="compact-xs" variant="default" onClick={() => setRetry(value => value + 1)}>重新加载</Button></Stack>}
    {!currentData && (loading || !error) ? <DataSkeleton rows={compact ? 3 : 5}/>
      : error && !currentData ? <Stack gap="xs" mt="md"><Text size="sm" c="red">{error}</Text><Button size="compact-xs" variant="default" onClick={() => setRetry(value => value + 1)}>重新加载</Button></Stack>
      : currentData?.nodeIds.length ? <><div className={styles.nodeList}>{(compact ? currentData.nodes.slice(0, 3) : currentData.nodes).map(node => <div key={node.id}>
        <CountryFlag code={resolveCountryCode({ countryCode: node.countryCode, region: node.region, name: node.name })} size="md"/><span><strong>{node.name}</strong>{!compact && <small>{node.region} · {node.provider}</small>}</span>{!compact && <Text size="xs" c="dimmed">已授权</Text>}
      </div>)}</div><Text size="sm" c="dimmed" mt="lg">共 {currentData.nodeIds.length} 个节点</Text></>
      : <Text size="sm" c="orange.7" mt="lg">未分配节点，请添加授权。</Text>}
  </section>;
}
