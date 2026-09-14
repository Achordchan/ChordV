import { useState } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { translateAgentStatus, translateXrayStatus } from "../../utils/admin-translate";
import { PanelInboundSection } from "./PanelInboundSection";
import { InboundDeploySection } from "./InboundDeploySection";
import styles from "./NodesWorkspace.module.css";
import dialogStyles from "../editors/EditorDialog.module.css";

export function NodeControlDetails({ node, onNodeRecordChanged, onResume, onEdit }: {
  node: AdminNodeRecordDto;
  onNodeRecordChanged: (node: AdminNodeRecordDto) => void;
  onResume: () => void;
  onEdit: () => void;
}) {
  const [showInbound, setShowInbound] = useState(false);
  const [editing, setEditing] = useState(false);
  const agent = node.agent;
  const isGoAgent = Boolean(agent?.version?.startsWith("go-"));
  const pending = node.registrationStatus === "pending_register" || (node.registrationStatus === "agent_ready" && node.inboundAppliedRevision === "0");
  const lastSeen = node.agentLastSeenAt ?? agent?.lastSeenAt;
  const values = [
    ["Agent 状态", translateAgentStatus(node.controlStatus ?? agent?.status)],
    ["Agent 版本", agent?.version?.trim() || "未上报"],
    ["Xray 状态", translateXrayStatus(agent?.xrayStatus)],
    ["批次确认", agent ? `${agent.lastAckSequence} / ${agent.lastSequence}` : "暂无数据"],
    ["待确认批次", agent ? `${agent.queueDepth}` : "暂无数据"],
    ["配置版本（当前 / 目标）", `${agent?.configRevision ?? "0"} / ${node.agentConfigRevision ?? "0"}`],
    ["最后心跳", lastSeen ? formatDateTimeWithYear(lastSeen) : "暂无心跳"]
  ];
  return <div className={styles.control}>
    <details className={styles.technical}><summary>技术详情</summary><dl className={styles.health}>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
    {pending ? <Button variant="subtle" size="compact-sm" color="teal.9" onClick={onResume}>继续接入</Button> : <Button variant="subtle" size="compact-sm" color="teal.9" onClick={() => { setEditing(false); setShowInbound(true); }}>入站配置</Button>}
    <Modal opened={showInbound} onClose={() => setShowInbound(false)} title={editing ? "调整入站" : "入站配置"} centered size="lg" classNames={{content: dialogStyles.content, header: dialogStyles.header, title: dialogStyles.title, body: dialogStyles.body}}>
      <Stack gap="lg" pb="lg">
        <div><Text fw={600}>{node.name}</Text><Text size="sm" c="dimmed">{node.serverHost}:{node.serverPort}</Text></div>
        {!editing ? <>
          <dl className={styles.inboundSummary}>
            <div><dt>连接协议</dt><dd>VLESS · Reality</dd></div>
            <div><dt>服务名称（SNI）</dt><dd>{node.serverName || "未配置"}</dd></div>
          </dl>
          {!agent ? <Text size="sm" c="dimmed">尚未接入 Agent，暂时无法校验或下发入站配置。</Text> : isGoAgent && node.isActive ? <Group justify="space-between"><Text size="sm" c="dimmed">重新校验前需先停用节点。</Text><Button variant="default" onClick={() => { setShowInbound(false); onEdit(); }}>编辑节点</Button></Group> : <Button color="teal.9" variant="light" onClick={() => setEditing(true)}>{isGoAgent ? "导入并校验" : "调整入站配置"}</Button>}
        </> : isGoAgent ? <PanelInboundSection key={`panel-${node.id}`} node={node} onNodeChanged={onNodeRecordChanged}/> : agent ? <InboundDeploySection key={node.id} node={node} onNodeChanged={onNodeRecordChanged}/> : null}
      </Stack>
    </Modal>
  </div>;
}
