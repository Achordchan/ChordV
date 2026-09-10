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
import { PanelInboundForm } from "./PanelInboundForm";

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
  const [panelInbound, setPanelInbound] = useState<Record<string, unknown> | null>(null);
  const { stage, result, node, error, creating, regenerating, submit, regenerate, retryValidation, refresh, invalidate } =
    useAgentNodeOnboarding(opened, initialNode, onNodeChanged);
  useLayoutEffect(() => { setName(""); setRegion(""); setProvider(""); setTags(""); setPanelInbound(null); }, [opened, initialNode?.id]);
  const handleClose = () => { invalidate(); onClose(); };
  const create = () => panelInbound && submit({ name: name.trim(), panelInbound, region: region.trim() || undefined,
    provider: provider.trim() || undefined, tags: tags.trim() ? tags.split(/[,，\s]+/).filter(Boolean) : undefined });

  // The install command references the origin the admin is already using. The
  // API routes live under the global /api prefix (openresty fronts both the SPA
  // and /api on one domain). The token travels in the POST BODY, never the URL:
  // access logs record paths and query strings, and a URL-embedded token would
  // let a log reader race the installer.
  const installCommand = result
    ? `(umask 077; f=$(mktemp) || exit 1; trap 'rm -f "$f"' EXIT; curl -fsSL --connect-timeout 15 --max-time 60 -X POST -H 'content-type: application/json' -d '{"token":"${result.registerToken}"}' '${window.location.origin}/api/agent-install/script.sh' -o "$f" && bash "$f")`
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
              在原生 3x-ui 面板中准备 VLESS + Reality 入站，设为不限期、不限流量，再导入分享链接。安装器会自动检查面板版本、API 和实际入站；校验完成后由你验收并激活。
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
          <PanelInboundForm onParsed={setPanelInbound} />
          {error ? (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{error}</Text>
            </Alert>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              取消
            </Button>
            <Button loading={creating} disabled={!name.trim() || !panelInbound} onClick={() => void create()}>
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
            <Code block style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
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

      {stage === "validating" ? <Stack gap="sm">
        <Group gap="xs"><Loader size="sm" /><Text size="sm">Agent 已注册，正在核对实际入站参数…</Text></Group>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={refresh}>刷新状态</Button><Button onClick={handleClose}>关闭</Button></Group>
      </Stack> : null}

      {stage === "ready" && node ? (
        <Stack gap="sm">
          <Alert color="teal" variant="light">
            <Group gap="xs">
              <Badge color="teal" variant="light" size="sm">校验完成</Badge>
              <Text size="sm">节点「{node.name}」已注册，实际入站参数核对通过。完成客户端连接和计量验收后，再手工激活。</Text>
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
              onClick={() => void (node?.registrationStatus === "agent_ready" ? retryValidation() : regenerate())}
            >
              {node?.registrationStatus === "agent_ready" ? "重新校验入站" : "重新生成安装命令"}
            </Button>
            <Button variant="default" size="xs" onClick={refresh}>刷新状态</Button>
            <Button variant="default" onClick={handleClose}>
              关闭
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}
