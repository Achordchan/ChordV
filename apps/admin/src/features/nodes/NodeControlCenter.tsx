import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Group,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon
} from "@mantine/core";
import type { AdminNodeRecordDto, NodeControlMode, SwitchNodeControlModeInputDto } from "@chordv/shared";
import {
  IconArrowRight,
  IconCheck,
  IconDatabase,
  IconRefreshAlert,
  IconServerCog,
  IconShieldCheck
} from "@tabler/icons-react";
import { StatusBadge } from "../shared/StatusBadge";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import {
  agentStatusColor,
  nodeControlModeColor,
  nodePanelColor,
  translateAgentStatus,
  translateNodeControlMode,
  translatePanelStatus,
  translateXrayStatus,
  xrayStatusColor
} from "../../utils/admin-translate";

type NodeControlDrawerProps = {
  node: AdminNodeRecordDto | null;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onSwitchMode: (node: AdminNodeRecordDto, input: SwitchNodeControlModeInputDto) => Promise<boolean>;
};

type TransitionDefinition = {
  targetMode: NodeControlMode;
  title: string;
  description: string;
  buttonLabel: string;
  color: string;
  requiresDirectConfirmation?: boolean;
  requiresRollbackConfirmation?: boolean;
  requiresXuiCalibration?: boolean;
};

export function NodeControlCell({ node, onOpen }: { node: AdminNodeRecordDto; onOpen: () => void }) {
  const mode = node.controlMode ?? "xui_primary";
  const agentStatus = node.controlStatus ?? node.agent?.status;

  return (
    <Stack gap={5} miw={168}>
      <Button
        variant="subtle"
        size="compact-sm"
        px={0}
        justify="flex-start"
        color={nodeControlModeColor(mode)}
        onClick={onOpen}
      >
        {translateNodeControlMode(mode)}
      </Button>
      {mode === "xui_primary" ? (
        <StatusBadge color={nodePanelColor(node.panelStatus, node.panelEnabled)} label={translatePanelStatus(node.panelStatus, node.panelEnabled)} />
      ) : (
        <Group gap={6} wrap="wrap">
          <StatusBadge color={agentStatusColor(agentStatus)} label={`Agent ${translateAgentStatus(agentStatus)}`} />
          <StatusBadge color={xrayStatusColor(node.agent?.xrayStatus)} label={`Xray ${translateXrayStatus(node.agent?.xrayStatus)}`} />
        </Group>
      )}
      <Text size="xs" c="dimmed" lineClamp={1}>
        {mode === "xui_primary"
          ? node.panelLastSyncedAt ? `同步 ${formatDateTimeWithYear(node.panelLastSyncedAt)}` : "尚未完成面板同步"
          : `revision ${node.agentConfigRevision ?? "0"}`}
      </Text>
    </Stack>
  );
}

export function NodeControlDrawer(props: NodeControlDrawerProps) {
  const [transition, setTransition] = useState<TransitionDefinition | null>(null);
  const [confirmedRisk, setConfirmedRisk] = useState(false);
  const [confirmedXuiCalibration, setConfirmedXuiCalibration] = useState(false);

  useEffect(() => {
    setTransition(null);
    setConfirmedRisk(false);
    setConfirmedXuiCalibration(false);
  }, [props.node?.id, props.node?.controlMode, props.opened]);

  const node = props.node;
  const mode = node?.controlMode ?? "xui_primary";
  const transitions = node ? buildTransitions(node) : [];

  async function submitTransition() {
    if (!node || !transition) return;
    const input: SwitchNodeControlModeInputDto = {
      targetMode: transition.targetMode,
      ...(transition.requiresDirectConfirmation ? { confirmDirect: true } : {}),
      ...(transition.requiresRollbackConfirmation ? { confirmRollback: true } : {}),
      ...(transition.requiresXuiCalibration ? { confirmXuiCalibrated: true } : {})
    };
    const succeeded = await props.onSwitchMode(node, input);
    if (succeeded) setTransition(null);
  }

  const canSubmit = transition
    ? ((!transition.requiresDirectConfirmation && !transition.requiresRollbackConfirmation) || confirmedRisk) &&
      (!transition.requiresXuiCalibration || confirmedXuiCalibration)
    : false;

  return (
    <>
      <Drawer opened={props.opened} onClose={props.onClose} title="节点控制器" position="right" size="xl">
        {node ? (
          <Stack gap="lg">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div>
                <Text fw={700} size="lg">{node.name}</Text>
                <Text size="sm" c="dimmed">{node.serverHost}:{node.serverPort}</Text>
              </div>
              <Badge color={nodeControlModeColor(mode)} variant="light" size="lg">
                {translateNodeControlMode(mode)}
              </Badge>
            </Group>

            <PhaseSummary node={node} />
            <ControlHealth node={node} />

            <Stack gap="sm">
              <Text fw={600}>当前阶段</Text>
              <PhaseChecklist node={node} />
            </Stack>

            <Divider />

            <Stack gap="sm">
              <Text fw={600}>可执行操作</Text>
              {transitions.map((item) => {
                const disabledReason = getTransitionDisabledReason(node, item.targetMode);
                return (
                  <Paper key={item.targetMode} withBorder radius="md" p="md">
                    <Group justify="space-between" align="center" wrap="wrap" gap="md">
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <Text fw={600}>{item.title}</Text>
                        <Text size="sm" c="dimmed">{disabledReason ?? item.description}</Text>
                      </div>
                      <Button
                        color={item.color}
                        variant={item.targetMode === "direct_primary" ? "filled" : "light"}
                        rightSection={<IconArrowRight size={16} />}
                        disabled={Boolean(disabledReason) || props.busy}
                        loading={props.busy}
                        onClick={() => setTransition(item)}
                      >
                        {item.buttonLabel}
                      </Button>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>

            {mode !== "xui_primary" ? (
              <Alert color="gray" variant="light" title="保留的 3X-UI 回退链路">
                面板状态：{translatePanelStatus(node.panelStatus, node.panelEnabled)}。面板配置仍保留，但不会在 Agent 主控阶段参与用户写入和计费。
              </Alert>
            ) : null}
          </Stack>
        ) : null}
      </Drawer>

      <Modal opened={Boolean(transition)} onClose={() => setTransition(null)} title={transition?.title ?? "确认控制模式"} centered>
        <Stack gap="md">
          <Alert color={transition?.color ?? "blue"} variant="light">
            {transition?.description}
          </Alert>
          {transition?.requiresDirectConfirmation || transition?.requiresRollbackConfirmation ? (
            <Checkbox
              checked={confirmedRisk}
              onChange={(event) => setConfirmedRisk(event.currentTarget.checked)}
              label={transition.requiresDirectConfirmation
                ? "我确认 UUID、email、Shadow 样本和流量基线已通过后台校验。"
                : "我确认这是人工回退操作，并已停止继续扩大 Direct 写入。"}
            />
          ) : null}
          {transition?.requiresXuiCalibration ? (
            <Checkbox
              checked={confirmedXuiCalibration}
              onChange={(event) => setConfirmedXuiCalibration(event.currentTarget.checked)}
              label="我确认 3X-UI 已使用相同 UUID/email 完成用户校准。"
            />
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setTransition(null)}>取消</Button>
            <Button color={transition?.color ?? "blue"} disabled={!canSubmit} loading={props.busy} onClick={() => void submitTransition()}>
              确认执行
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function PhaseSummary({ node }: { node: AdminNodeRecordDto }) {
  const mode = node.controlMode ?? "xui_primary";
  const content = {
    xui_primary: ["3X-UI 是唯一用户写入方和计费来源。", "blue"],
    shadow_direct: ["Agent 只读采样并核对数据，3X-UI 仍是唯一写入和计费来源。", "grape"],
    direct_primary: ["Agent 是唯一用户写入方和计费来源，3X-UI 仅保留用于人工回退。", "green"],
    rollback_pending: ["节点已进入人工回退窗口，完成校准前禁止切回 3X-UI。", "orange"]
  }[mode] as [string, string];
  return <Alert color={content[1]} variant="light">{content[0]}</Alert>;
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

function PhaseChecklist({ node }: { node: AdminNodeRecordDto }) {
  const mode = node.controlMode ?? "xui_primary";
  const items = mode === "xui_primary"
    ? ["确认面板入站和用户绑定完整", "部署 Agent 并等待 Agent/Xray 健康", "进入 Shadow 前不会改变现有计费"]
    : mode === "shadow_direct"
      ? ["Agent 持续只读采样", "序号与 ACK 必须连续一致", "切换 Direct 时后台原子建立新基线"]
      : mode === "direct_primary"
        ? ["Agent 负责用户增删、启停和计量", "后台按批次幂等入账", "3X-UI 不得继续写入 Xray"]
        : ["暂停扩大 Direct 写入", "等待 Agent 最后采样全部确认", "校准 3X-UI UUID/email 后完成回退"];
  return (
    <Stack gap={6}>
      {items.map((item) => (
        <Group key={item} gap="xs" wrap="nowrap" align="flex-start">
          <ThemeIcon size="sm" color={nodeControlModeColor(mode)} variant="light" radius="xl"><IconCheck size={12} /></ThemeIcon>
          <Text size="sm">{item}</Text>
        </Group>
      ))}
    </Stack>
  );
}

function buildTransitions(node: AdminNodeRecordDto): TransitionDefinition[] {
  const mode = node.controlMode ?? "xui_primary";
  if (mode === "xui_primary") return [{ targetMode: "shadow_direct", title: "进入 Shadow 对账", description: "Agent 开始只读采样；3X-UI 的用户写入和计费行为保持不变。", buttonLabel: "进入 Shadow", color: "grape" }];
  if (mode === "shadow_direct") return [
    { targetMode: "xui_primary", title: "退出 Shadow", description: "停止 Agent 影子对账，恢复为纯 3X-UI 主控状态。", buttonLabel: "退出 Shadow", color: "gray" },
    { targetMode: "direct_primary", title: "切换为 Agent 主控", description: "后台会结清旧链路、校验 Shadow 样本并原子建立 Direct 基线。", buttonLabel: "切换 Direct", color: "green", requiresDirectConfirmation: true }
  ];
  if (mode === "direct_primary") return [{ targetMode: "rollback_pending", title: "开始人工回退", description: "进入回退窗口，等待最后采样确认并校准 3X-UI。此操作不会直接完成切换。", buttonLabel: "开始回退", color: "orange", requiresRollbackConfirmation: true }];
  return [{ targetMode: "xui_primary", title: "完成回退到 3X-UI", description: "后台将读取 3X-UI 绝对计数建立新基线，再恢复 3X-UI 主控。", buttonLabel: "完成回退", color: "orange", requiresRollbackConfirmation: true, requiresXuiCalibration: true }];
}

function getTransitionDisabledReason(node: AdminNodeRecordDto, targetMode: NodeControlMode) {
  const agent = node.agent;
  if (targetMode === "xui_primary" && (node.controlMode ?? "xui_primary") === "shadow_direct") return null;
  if (targetMode === "xui_primary" && node.controlMode === "rollback_pending" && node.panelStatus !== "online") return "3X-UI 面板当前不在线，不能完成回退。";
  if (!agent || agent.status !== "online") return "Agent 尚未在线，不能执行此阶段切换。";
  if (agent.xrayStatus !== "healthy") return "Xray 状态不健康，不能执行此阶段切换。";
  if (targetMode === "shadow_direct") return null;
  if (agent.queueDepth > 0) return `仍有 ${agent.queueDepth} 个本地待确认批次。`;
  if (agent.lastSequence !== agent.lastAckSequence) return `批次序号 ${agent.lastSequence} 尚未全部确认到 ${agent.lastAckSequence}。`;
  if (agent.configRevision !== (node.agentConfigRevision ?? "0")) return "Agent 配置 revision 尚未追平后台。";
  return null;
}
