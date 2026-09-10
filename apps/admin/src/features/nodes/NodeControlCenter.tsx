import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Divider,
  Drawer,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon
} from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import {
  IconDatabase,
  IconRefreshAlert,
  IconServerCog,
  IconShieldCheck,
  IconCheck
} from "@tabler/icons-react";
import { StatusBadge } from "../shared/StatusBadge";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { PanelInboundSection } from "./PanelInboundSection";
import { InboundDeploySection } from "./InboundDeploySection";
import {
  agentStatusColor,
  translateAgentStatus,
  translateXrayStatus,
  xrayStatusColor
} from "../../utils/admin-translate";

type NodeControlDrawerProps = {
  node: AdminNodeRecordDto | null;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onNodeRecordChanged: (node: AdminNodeRecordDto) => void;
};

export function NodeControlCell({ node, onOpen }: { node: AdminNodeRecordDto; onOpen: () => void }) {
  const agentStatus = node.controlStatus ?? node.agent?.status;

  return (
    <Stack gap={5} miw={168}>
      <Button
        variant="subtle"
        size="compact-sm"
        px={0}
        justify="flex-start"
        color={agentStatusColor(agentStatus)}
        onClick={onOpen}
      >
        {`Agent ${translateAgentStatus(agentStatus)}`}
      </Button>
      <Group gap={6} wrap="wrap">
        <StatusBadge color={agentStatusColor(agentStatus)} label={`Agent ${translateAgentStatus(agentStatus)}`} />
        <StatusBadge color={xrayStatusColor(node.agent?.xrayStatus)} label={`Xray ${translateXrayStatus(node.agent?.xrayStatus)}`} />
      </Group>
      <Text size="xs" c="dimmed" lineClamp={1}>
        {`revision ${node.agentConfigRevision ?? "0"}`}
      </Text>
    </Stack>
  );
}

export function NodeControlDrawer(props: NodeControlDrawerProps) {
  const node = props.node;

  return (
    <Drawer opened={props.opened} onClose={props.onClose} title="节点控制器" position="right" size="xl">
      {node ? (
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div>
              <Text fw={700} size="lg">{node.name}</Text>
              <Text size="sm" c="dimmed">{node.serverHost}:{node.serverPort}</Text>
            </div>
            <Badge color={agentStatusColor(node.controlStatus ?? node.agent?.status)} variant="light" size="lg">
              {`Agent ${translateAgentStatus(node.controlStatus ?? node.agent?.status)}`}
            </Badge>
          </Group>

          <ControlHealth node={node} />

          <Divider />

          {/* Keyed by node id: the drawer reuses this component across node
              switches, and a stale open modal (form values, a confirmed key
              rotation) must never carry into the next node. */}
          <PanelInboundSection key={`panel-${node.id}`} node={node} onNodeChanged={props.onNodeRecordChanged} />
          {!node.agent?.version?.startsWith("go-") && <InboundDeploySection key={node.id} node={node} onNodeChanged={props.onNodeRecordChanged} />}
        </Stack>
      ) : null}
    </Drawer>
  );
}

function ControlHealth({ node }: { node: AdminNodeRecordDto }) {
  const agent = node.agent;
  const sequenceSynced = agent ? agent.lastSequence === agent.lastAckSequence : false;
  return (
    <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
      <HealthItem icon={<IconServerCog size={18} />} label="Agent" value={translateAgentStatus(node.controlStatus ?? agent?.status)} color={agentStatusColor(node.controlStatus ?? agent?.status)} />
      <HealthItem icon={<IconShieldCheck size={18} />} label="Xray" value={translateXrayStatus(agent?.xrayStatus)} color={xrayStatusColor(agent?.xrayStatus)} />
      <HealthItem icon={<IconDatabase size={18} />} label="批次确认" value={agent ? `${agent.lastAckSequence} / ${agent.lastSequence}` : "暂无 Agent"} color={sequenceSynced ? "green" : "yellow"} />
      <HealthItem icon={<IconRefreshAlert size={18} />} label="本地队列" value={agent ? `${agent.queueDepth} 个待确认批次` : "暂无 Agent"} color={agent?.queueDepth === 0 ? "green" : "yellow"} />
      <HealthItem icon={<IconCheck size={18} />} label="配置 revision" value={`${agent?.configRevision ?? "0"} / ${node.agentConfigRevision ?? "0"}`} color={agent?.configRevision === node.agentConfigRevision ? "green" : "yellow"} />
      <HealthItem icon={<IconServerCog size={18} />} label="最后心跳" value={node.agentLastSeenAt ?? agent?.lastSeenAt ? formatDateTimeWithYear(node.agentLastSeenAt ?? agent!.lastSeenAt!) : "暂无心跳"} color={agent?.status === "online" ? "green" : "gray"} />
    </SimpleGrid>
  );
}

function HealthItem(props: { icon: ReactNode; label: string; value: string; color: string }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon color={props.color} variant="light" radius="md">{props.icon}</ThemeIcon>
        <div style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed">{props.label}</Text>
          <Text size="sm" fw={600} lineClamp={1}>{props.value}</Text>
        </div>
      </Group>
    </Paper>
  );
}
