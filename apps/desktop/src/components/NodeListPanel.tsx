import { Badge, Button, Group, Paper, ScrollArea, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { NodeSummaryDto } from "@chordv/shared";
import { IconBolt, IconRefresh, IconRosetteDiscountCheck } from "@tabler/icons-react";
import type { RuntimeNodeProbeResult } from "../lib/runtime";
import { CountryFlag } from "./CountryFlag";

type NodeListPanelProps = {
  nodes: NodeSummaryDto[];
  selectedNodeId: string | null;
  probeResults: Record<string, RuntimeNodeProbeResult>;
  probeBusy: boolean;
  probeCooldownLeft: number;
  onSelect: (nodeId: string) => void;
  onProbe: () => void;
};

export function NodeListPanel(props: NodeListPanelProps) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  const listContent = (
    <Stack gap={8}>
      {props.nodes.map((node) => {
        const probe: RuntimeNodeProbeResult | undefined = Object.hasOwn(props.probeResults, node.id) ? props.probeResults[node.id] : undefined;
        const isSelected = props.selectedNodeId === node.id;
        const latency = probe?.latencyMs ?? null;
        const status = probe?.status ?? "unknown";
        const statusLabel = status === "unknown" ? "未检测" : status === "healthy" ? "可用" : "不可用";

        return (
          <div
            key={node.id}
            className={isSelected ? "node-item node-item--selected" : "node-item"}
            data-status={status}
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            onClick={() => props.onSelect(node.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelect(node.id);
              }
            }}
          >
            <ThemeIcon
              size={isMobile ? 30 : 28}
              radius="xl"
              variant={isSelected ? "filled" : "light"}
              color={isSelected ? "cyan" : status === "healthy" ? "green" : "gray"}
              className="node-item__icon"
            >
              {isSelected ? <IconRosetteDiscountCheck size={16} /> : <IconBolt size={14} />}
            </ThemeIcon>
            <div className="node-item__body">
              <div className="node-item__title-row">
                <Text fw={600} className="node-item__name" lineClamp={1}>
                  {node.name}
                </Text>
                {node.recommended ? (
                  <Badge size="xs" variant="light" color="cyan">
                    推荐
                  </Badge>
                ) : null}
              </div>
              <div className="node-item__meta">
                <CountryFlag code={node.countryCode} size="sm" />
                <Text size="xs" c="dimmed" lineClamp={1} className="node-item__region">
                  {node.region} · {node.provider}
                </Text>
                <span className="node-item__status">
                  <span className="node-item__status-dot" aria-hidden="true" />
                  {statusLabel}
                </span>
              </div>
              {probe?.error ? (
                <Text size="xs" c={status === "unknown" ? "dimmed" : "red.6"} className="node-item__error">
                  {probe.error}
                </Text>
              ) : null}
            </div>
            <div className="node-item__latency">
              <Text fw={650} className="node-item__latency-value">
                {latency !== null && latency !== undefined ? `${latency}ms` : "--"}
              </Text>
              <Text size="xs" c="dimmed">
                本机 TCP 延迟
              </Text>
            </div>
          </div>
        );
      })}
    </Stack>
  );

  return (
    <Paper
      withBorder
      p="md"
      className={isMobile ? "desktop-panel node-list-panel node-list-panel--mobile" : "desktop-panel node-list-panel"}
    >
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="center" className="node-list-head">
          <Stack gap={2}>
            <Title order={3} className="panel-title">节点列表</Title>
            {isMobile ? (
              <Text size="sm" c="dimmed">
                选择一个延迟更低的节点作为当前出口。
              </Text>
            ) : null}
          </Stack>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<IconRefresh size={15} />}
            className="node-list-probe-button"
            onClick={props.onProbe}
            disabled={props.probeBusy || props.probeCooldownLeft > 0 || props.nodes.length === 0}
            loading={props.probeBusy}
          >
            {props.probeCooldownLeft > 0 ? `${props.probeCooldownLeft}s` : "测速"}
          </Button>
        </Group>

        {props.nodes.length === 0 ? (
          <div className="empty-state">
            <Stack gap="xs" align="center">
              <IconBolt size={18} />
              <Text fw={600}>暂无可用节点</Text>
            </Stack>
          </div>
        ) : (
          isMobile ? listContent : <ScrollArea className="node-scroll">{listContent}</ScrollArea>
        )}
      </Stack>
    </Paper>
  );
}
