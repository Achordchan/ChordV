import { useLayoutEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip
} from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { useAgentNodeOnboarding } from "./useAgentNodeOnboarding";

export function AgentNodeCreateModal({ opened, onClose, onNodeChanged, initialNode = null }: {
  opened: boolean;
  onClose: () => void;
  onNodeChanged: (node: AdminNodeRecordDto) => void;
  initialNode?: AdminNodeRecordDto | null;
}) {
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [provider, setProvider] = useState("");
  const [tags, setTags] = useState("");
  const { stage, result, node, error, creating, regenerating, submit, regenerate, invalidate } =
    useAgentNodeOnboarding(opened, initialNode, onNodeChanged);
  useLayoutEffect(() => { setName(""); setRegion(""); setProvider(""); setTags(""); }, [opened, initialNode?.id]);
  const handleClose = () => { invalidate(); onClose(); };
  const create = () => submit({ name: name.trim(), region: region.trim() || undefined,
    provider: provider.trim() || undefined, tags: tags.trim() ? tags.split(/[,，\s]+/).filter(Boolean) : undefined });

  // The install command references the origin the admin is already using. The
  // API routes live under the global /api prefix (openresty fronts both the SPA
  // and /api on one domain). The token travels in the POST BODY, never the URL:
  // access logs record paths and query strings, and a URL-embedded token would
  // let a log reader race the installer.
  const installCommand = result
    ? `curl -fsSL -X POST -H 'content-type: application/json' -d '{"token":"${result.registerToken}"}' ${window.location.origin}/api/agent-install/script.sh | bash`
    : "";

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={initialNode ? "继续接入节点" : "添加节点（Agent 接入）"}
      centered
      size="lg"
      closeOnClickOutside={stage === "form" || stage === "ready" || stage === "failed"}
    >
      {stage === "form" ? (
        <Stack gap="sm">
          <Alert color="blue" variant="light" p="xs">
            <Text size="xs">
              这里生成的是旧 Node/Xray 安装命令，仅供非面板共存节点。3x-ui 共存节点不要执行此脚本：创建后按 Go agent 接入手册手工注册，再在节点控制器导入面板链接。
            </Text>
          </Alert>
          <TextInput label="节点名称" required value={name} onChange={(event) => setName(event.currentTarget.value)} />
          <Group grow>
            <TextInput label="地区" placeholder="如：香港" value={region} onChange={(event) => setRegion(event.currentTarget.value)} />
            <TextInput label="供应商" placeholder="可选" value={provider} onChange={(event) => setProvider(event.currentTarget.value)} />
          </Group>
          <TextInput
            label="标签"
            placeholder="逗号分隔，可选"
            value={tags}
            onChange={(event) => setTags(event.currentTarget.value)}
          />
          {error ? (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{error}</Text>
            </Alert>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              取消
            </Button>
            <Button loading={creating} disabled={!name.trim()} onClick={() => void create()}>
              创建并生成安装命令
            </Button>
          </Group>
        </Stack>
      ) : null}

      {stage === "resume" && node ? (
        <Stack gap="sm">
          <Text size="sm">节点「{node.name}」尚未注册。安装命令仅显示一次，重新生成会使旧命令失效。</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>关闭</Button>
            <Button loading={regenerating} onClick={() => void regenerate()}>重新生成安装命令并继续接入</Button>
          </Group>
        </Stack>
      ) : null}

      {stage === "awaiting" && result ? (
        <Stack gap="sm">
          <Alert color="blue" variant="light">
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm">节点已创建（{node?.name}），等待 Agent 注册…安装命令在目标 VPS 上以 root 执行后，此处将自动更新。</Text>
            </Group>
          </Alert>
          <Text size="xs" fw={700}>
            在目标 VPS 上执行以下命令（有效期至 {new Date(result.registerTokenExpiresAt).toLocaleString()}）：
          </Text>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <Code block style={{ flex: 1, wordBreak: "break-all" }}>
              {installCommand}
            </Code>
            <CopyButton value={installCommand} timeout={2000}>
              {({ copied, copy }) => (
                <Button color={copied ? "teal" : "blue"} size="compact-xs" onClick={copy}>
                  {copied ? "已复制" : "复制"}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Group justify="space-between">
            <Button
              variant="subtle"
              size="xs"
              color="blue"
              loading={regenerating}
              onClick={() => void regenerate()}
            >
              令牌过期/丢失？重新生成安装命令
            </Button>
            <Tooltip label="中止等待并关闭（节点保留，安装命令可重新生成）">
              <Button variant="subtle" color="gray" size="xs" onClick={handleClose}>
                稍后再说，关闭窗口
              </Button>
            </Tooltip>
          </Group>
        </Stack>
      ) : null}

      {stage === "ready" && node ? (
        <Stack gap="sm">
          <Alert color="teal" variant="light">
            <Group gap="xs">
              <Badge color="teal" variant="light" size="sm">已就绪</Badge>
              <Text size="sm">节点「{node.name}」的 Agent 已注册。连接参数将由入站部署完成后生效。</Text>
            </Group>
          </Alert>
          <Group justify="flex-end">
            <Button onClick={handleClose}>完成</Button>
          </Group>
        </Stack>
      ) : null}

      {stage === "failed" ? (
        <Stack gap="sm">
          <Alert color="red" variant="light">
            <Text size="sm">{error}</Text>
          </Alert>
          {result ? <Textarea
            label="安装命令（保留备用）"
            value={installCommand}
            readOnly
            autosize
            minRows={2}
            styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
          /> : null}
          <Group justify="space-between">
            <Button
              size="xs"
              color="blue"
              variant="light"
              loading={regenerating}
              onClick={() => void regenerate()}
            >
              重新生成安装命令并继续等待
            </Button>
            <Button variant="default" onClick={handleClose}>
              关闭
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}
