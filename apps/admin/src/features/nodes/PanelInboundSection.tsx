import { useLayoutEffect, useState } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { useInboundDeployment } from "./useInboundDeployment";
import { PanelInboundForm } from "./PanelInboundForm";

export function PanelInboundSection({ node, onNodeChanged }: { node: AdminNodeRecordDto; onNodeChanged: (node: AdminNodeRecordDto) => void }) {
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [revision, setRevision] = useState("");
  const deployment = useInboundDeployment(node.id, onNodeChanged);
  useLayoutEffect(() => { setSpec(null); setRevision(""); }, [node.id]);
  if (!node.agent?.version?.startsWith("go-")) {
    return <Text size="sm" c="dimmed">请先完成 Go Agent 接入，再配置入站。</Text>;
  }
  if (node.isActive) {
    return <Text size="sm" c="dimmed">节点已启用，请先停用再重新校验。</Text>;
  }
  return <Stack gap="sm">
    <Text fw={600}>导入并校验</Text>
    <PanelInboundForm key={node.id} onParsed={value => { setSpec(value); setRevision(node.inboundAppliedRevision ?? "0"); }} />
    {spec && <Button loading={deployment.deploying}
      disabled={deployment.stage === "queued" || node.isActive || revision !== (node.inboundAppliedRevision ?? "0") || !node.agent?.version?.startsWith("go-")}
      onClick={() => void deployment.deploy(node, spec, revision)}>下发只读校验并保存连接参数</Button>}
    {deployment.error && <Alert color="red">{deployment.error}</Alert>}
    {deployment.stage === "queued" && <Group justify="space-between"><Text size="sm" c="dimmed">等待 Agent 回报校验结果</Text><Button size="xs" variant="default" onClick={deployment.refresh}>重新读取状态</Button></Group>}
    {deployment.stage === "done" && <Alert color="teal">入站校验完成，连接参数已保存；实际流量验收后再手工激活。</Alert>}
  </Stack>;
}
