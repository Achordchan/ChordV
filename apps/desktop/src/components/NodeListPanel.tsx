import { Badge, Button, Group, Paper, ScrollArea, Stack, Text, Title } from "@mantine/core";
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
  return (
    <Paper withBorder radius="xl" p="lg" className="desktop-panel">
      <Stack gap="md" h="100%">
        <Group justify="space-between" align="center" className="node-list-head">
          <div>
            <Title order={3}>节点列表</Title>
          </div>
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
          <Paper withBorder radius="lg" p="lg" className="empty-state">
            <Stack gap="xs" align="center">
              <IconBolt size={18} />
              <Text fw={600}>暂无可用节点</Text>
            </Stack>
          </Paper>
        ) : (
          <ScrollArea className="node-scroll">
            <Stack gap="sm">
              {props.nodes.map((node) => {
                const probe = props.probeResults[node.id];
                const isSelected = props.selectedNodeId === node.id;
                const latency = probe?.latencyMs ?? node.latencyMs;
                const status = probe?.status ?? "healthy";

                return (
                  <Paper
                    key={node.id}
                    withBorder
                    radius="lg"
                    p="md"
                    className={isSelected ? "node-item node-item--selected" : "node-item"}
                    onClick={() => props.onSelect(node.id)}
                  >
                    <Group justify="space-between" align="start">
                      <div>
                        <Group gap="xs">
                          <Text fw={600}>{node.name}</Text>
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
                        </Group>
                        <Text size="sm" c="dimmed" mt={4}>
                          {node.region} · {node.provider}
                        </Text>
                        {probe?.error ? (
                          <Text size="xs" c="red.6" mt={6}>
                            {probe.error}
                          </Text>
                        ) : null}
                      </div>

                      <Stack gap={6} align="end">
                        {isSelected ? <IconRosetteDiscountCheck size={18} color="#0891b2" /> : null}
                        <Badge variant="light" color={status === "healthy" ? "green" : "red"}>
                          {status === "healthy" ? "可用" : "不可用"}
                        </Badge>
                        <Text fw={700}>{latency !== null && latency !== undefined ? `${latency}ms` : "--"}</Text>
                      </Stack>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          </ScrollArea>
        )}
      </Stack>
    </Paper>
  );
}
