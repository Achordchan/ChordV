import { Badge, Button, Group, Paper, ScrollArea, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { NodeSummaryDto } from "@chordv/shared";
import { IconBolt, IconRefresh, IconRosetteDiscountCheck } from "@tabler/icons-react";
import type { RuntimeNodeProbeResult } from "../lib/runtime";

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
    <Stack gap={isMobile ? 8 : "sm"}>
      {props.nodes.map((node) => {
        const probe = props.probeResults[node.id];
        const isSelected = props.selectedNodeId === node.id;
        const latency = probe?.latencyMs ?? node.latencyMs;
        const status = probe?.status ?? "healthy";

        return (
          <Paper
            key={node.id}
            withBorder
            radius="md"
            p="md"
            className={isSelected ? "node-item node-item--selected" : "node-item"}
            role="button"
            tabIndex={0}
            onClick={() => props.onSelect(node.id)}
            style={
              isMobile
                ? {
                    padding: 14,
                    borderRadius: 20,
                    boxShadow: "none",
                    transform: "none",
                    background:
                      isSelected
                        ? "linear-gradient(135deg, rgba(8,145,178,0.12), rgba(34,211,238,0.08))"
                        : "rgba(255,255,255,0.92)"
                  }
                : undefined
            }
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: 1 }}>
                <ThemeIcon
                  size={isMobile ? 30 : 24}
                  radius="xl"
                  variant={isSelected ? "filled" : "light"}
                  color={isSelected ? "cyan" : status === "healthy" ? "green" : "gray"}
                  mt={2}
                >
                  {isSelected ? <IconRosetteDiscountCheck size={16} /> : <IconBolt size={14} />}
                </ThemeIcon>
                <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                  <Text fw={600}>{node.name}</Text>
                  <Group gap="xs" wrap="wrap">
                    {isSelected ? (
                      <Badge variant="filled" color="cyan">
                        当前选择
                      </Badge>
                    ) : null}
                    {node.recommended ? (
                      <Badge variant="light" color="cyan">
                        推荐
                      </Badge>
                    ) : null}
                    <Badge variant="light" color={status === "healthy" ? "green" : "red"}>
                      {status === "healthy" ? "可用" : "不可用"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" lineClamp={1}>
                    {node.region} · {node.provider}
                  </Text>
                  {probe?.error ? (
                    <Text size="xs" c="red.6">
                      {probe.error}
                    </Text>
                  ) : null}
                </Stack>
              </Group>

              <Stack gap={2} align="end" style={{ flexShrink: 0 }}>
                <Text fw={700} size={isMobile ? "lg" : undefined}>
                  {latency !== null && latency !== undefined ? `${latency}ms` : "--"}
                </Text>
                <Text size="xs" c="dimmed">
                  延迟
                </Text>
              </Stack>
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );

  return (
    <Paper
      withBorder
      radius={isMobile ? 28 : 18}
      p={isMobile ? "md" : "lg"}
      className={isMobile ? "desktop-panel node-list-panel node-list-panel--mobile" : "desktop-panel node-list-panel"}
    >
      <Stack gap={isMobile ? "sm" : "md"} h="100%">
        <Group justify="space-between" align="center" className="node-list-head">
          <Stack gap={2}>
            <Title order={3}>节点列表</Title>
            {isMobile ? (
              <Text size="sm" c="dimmed">
                选择一个延迟更低的节点作为当前出口。
              </Text>
            ) : null}
          </Stack>
          <Button
            variant="default"
            size="compact-md"
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
          <Paper withBorder radius="md" p="lg" className="empty-state">
            <Stack gap="xs" align="center">
              <IconBolt size={18} />
              <Text fw={600}>暂无可用节点</Text>
            </Stack>
          </Paper>
        ) : (
          isMobile ? listContent : <ScrollArea className="node-scroll">{listContent}</ScrollArea>
        )}
      </Stack>
    </Paper>
  );
}
