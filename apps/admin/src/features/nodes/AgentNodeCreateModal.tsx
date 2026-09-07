import { useCallback, useEffect, useRef, useState } from "react";
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
import { notifications } from "@mantine/notifications";
import type { AdminNodeRecordDto, CreateAgentNodeResultDto } from "@chordv/shared";
import { createAgentNode } from "../../api/nodes";

type Stage = "form" | "awaiting" | "ready" | "failed";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

function parseErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return raw;
}

/**
 * Agent-native node onboarding (docs/prd/node-revision-agent-native.md, R1):
 * collect descriptive fields, create a pending_register node, then guide the
 * admin through running the generated install command on the VPS while this
 * modal polls for the agent's registration.
 */
export function AgentNodeCreateModal({
  opened,
  onClose,
  onNodeRegistered
}: {
  opened: boolean;
  onClose: () => void;
  onNodeRegistered: (node: AdminNodeRecordDto) => void;
}) {
  const [stage, setStage] = useState<Stage>("form");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [provider, setProvider] = useState("");
  const [tags, setTags] = useState("");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreateAgentNodeResultDto | null>(null);
  const [node, setNode] = useState<AdminNodeRecordDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const pollDeadline = useRef<number>(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, []);

  const reset = useCallback(() => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setStage("form");
    setResult(null);
    setNode(null);
    setError(null);
    setCreating(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    setName("");
    setRegion("");
    setProvider("");
    setTags("");
    onClose();
  }, [onClose, reset]);

  const pollRegistration = useCallback(
    (nodeId: string) => {
      pollDeadline.current = Date.now() + POLL_TIMEOUT_MS;
      const tick = async () => {
        if (!mounted.current) return;
        try {
          // Reuse the existing nodes list fetch: the node's registrationStatus
          // flips to agent_ready when the agent registers.
          const { fetchAdminNodes } = await import("../../api/nodes");
          const nodes = await fetchAdminNodes();
          if (!mounted.current) return;
          const current = nodes.find((candidate) => candidate.id === nodeId) ?? null;
          if (current?.registrationStatus === "agent_ready") {
            setNode(current);
            setStage("ready");
            notifications.show({
              color: "teal",
              title: "节点已接入",
              message: `v 节点「${current.name}」的 Agent 已完成注册。`
            });
            onNodeRegistered(current);
            return;
          }
        } catch {
          // transient poll failure: keep waiting within the deadline
        }
        if (Date.now() >= pollDeadline.current) {
          setStage("failed");
          setError("等待超时：15 分钟内未检测到 Agent 注册。请检查 VPS 上的安装输出，或重新生成安装命令。");
          return;
        }
        pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
      };
      pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    },
    [onNodeRegistered]
  );

  const submit = useCallback(async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createAgentNode({
        name: name.trim(),
        region: region.trim() || undefined,
        provider: provider.trim() || undefined,
        tags: tags.trim() ? tags.split(/[,，\s]+/).filter(Boolean) : undefined
      });
      if (!mounted.current) return;
      setResult(created);
      setNode(created.node);
      setStage("awaiting");
      pollRegistration(created.node.id);
    } catch (err) {
      if (mounted.current) {
        setError(parseErrorMessage(err));
        setStage("form");
        notifications.show({ color: "red", title: "创建节点失败", message: parseErrorMessage(err) });
      }
    } finally {
      if (mounted.current) setCreating(false);
    }
  }, [creating, name, pollRegistration, provider, region, tags]);

  // The install command references the origin the admin is already using.
  const installCommand = result
    ? `curl -fsSL ${window.location.origin}/agent-install/${result.registerToken}.sh | bash`
    : "";

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="添加节点（Agent 接入）"
      centered
      size="lg"
      closeOnClickOutside={stage === "form" || stage === "ready" || stage === "failed"}
    >
      {stage === "form" ? (
        <Stack gap="sm">
          <Alert color="blue" variant="light" p="xs">
            <Text size="xs">
              创建后将在目标 VPS 上执行一条安装命令完成接入：节点连接参数由 Agent 自动上报，无需填写 3x-ui 面板信息。
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
            <Button loading={creating} disabled={!name.trim()} onClick={() => void submit()}>
              创建并生成安装命令
            </Button>
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
          <Tooltip label="中止等待并关闭（节点保留，可稍后在节点列表重新生成安装命令）">
            <Button variant="subtle" color="gray" size="xs" onClick={handleClose}>
              稍后再说，关闭窗口
            </Button>
          </Tooltip>
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
          <Textarea
            label="安装命令（保留备用）"
            value={installCommand}
            readOnly
            autosize
            minRows={2}
            styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              关闭
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}
