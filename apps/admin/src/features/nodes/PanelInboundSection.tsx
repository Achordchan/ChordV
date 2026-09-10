import { useLayoutEffect, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { useInboundDeployment } from "./useInboundDeployment";
import { PanelInboundForm } from "./PanelInboundForm";

export function PanelInboundSection({ node, onNodeChanged }: { node: AdminNodeRecordDto; onNodeChanged: (node: AdminNodeRecordDto) => void }) {
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [revision, setRevision] = useState("");
  const deployment = useInboundDeployment(node.id, onNodeChanged);
  useLayoutEffect(() => { setSpec(null); setRevision(""); }, [node.id]);
  return <Stack gap="sm">
    <Text fw={600}>面板入站导入与只读校验</Text>
    <PanelInboundForm key={node.id} onParsed={value => { setSpec(value); setRevision(node.inboundAppliedRevision ?? "0"); }} />
    {node.isActive && <Alert color="orange">请先停用节点再重新校验。</Alert>}
    {!node.agent?.version?.startsWith("go-") && <Alert color="orange">请先完成 Go agent 一键接入。</Alert>}
    {spec && <Button loading={deployment.deploying}
      disabled={node.isActive || revision !== (node.inboundAppliedRevision ?? "0") || !node.agent?.version?.startsWith("go-")}
      onClick={() => void deployment.deploy(node, spec, revision)}>下发只读校验并保存连接参数</Button>}
    {deployment.error && <Alert color="red">{deployment.error}</Alert>}
    {deployment.stage === "done" && <Alert color="teal">入站校验完成，连接参数已保存；实际流量验收后再手工激活。</Alert>}
  </Stack>;
}
