import { useEffect, useState } from "react";
import { Alert, Button, Code, CopyButton, Group, Modal, Stack, Text } from "@mantine/core";
import type { AdminDomesticProbeStateDto } from "@chordv/shared";
import { fetchDomesticProbeState, revokeDomesticProbeToken, rotateDomesticProbeToken } from "../../api/domestic-probe";
import { formatDateTime } from "../../utils/admin-format";

/**
 * Token management for the domestic probe: a server inside mainland China
 * that checks every node's port every few minutes and reports back, so the
 * node list can show whether a node is blocked from China.
 */
export function DomesticProbeModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [state, setState] = useState<AdminDomesticProbeStateDto | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setToken(null);
    setError(null);
    fetchDomesticProbeState().then(setState, (reason: unknown) => setError(readMessage(reason)));
  }, [opened]);

  const run = async (action: () => Promise<AdminDomesticProbeStateDto & { token?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setToken(next.token ?? null);
    } catch (reason) {
      setError(readMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return <Modal opened={opened} onClose={onClose} title="国内探针" size="lg">
    <Stack gap="md">
      <Text size="sm" c="dimmed">国内探针是一台中国大陆的服务器，每 5 分钟对每个节点的地址和端口做一次 TCP 握手，并把结果报回后台。连续 3 轮不通且节点 Agent 在线时，节点会显示为「国内被墙」。端口能连通不代表 Reality 一定可用。</Text>
      {error ? <Alert color="red" variant="light">{error}</Alert> : null}
      {state ? <Stack gap={4}>
        <Text size="sm">令牌：{state.configured ? `已启用（${state.tokenPrefix}…，${state.tokenCreatedAt ? formatDateTime(state.tokenCreatedAt) : ""} 生成）` : "未启用"}</Text>
        <Text size="sm">最近上报：{state.lastReportAt ? formatDateTime(state.lastReportAt) : "还没有"}{state.lastRoundIgnored && state.lastRoundReason ? `（已忽略：${state.lastRoundReason}）` : ""}</Text>
      </Stack> : null}
      {token ? <Alert color="teal" variant="light" title="新令牌只显示这一次">
        <Stack gap="xs">
          <Code block>{token}</Code>
          <Text size="xs">把它写进探针服务器的配置文件。旧令牌已经失效。</Text>
          <CopyButton value={token}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? "已复制" : "复制令牌"}</Button>}</CopyButton>
        </Stack>
      </Alert> : null}
      <Group justify="flex-end">
        {state?.configured ? <Button variant="subtle" color="red" loading={busy} onClick={() => void run(revokeDomesticProbeToken)}>停用令牌</Button> : null}
        <Button loading={busy} onClick={() => void run(rotateDomesticProbeToken)}>{state?.configured ? "重新生成令牌" : "生成令牌"}</Button>
      </Group>
    </Stack>
  </Modal>;
}

function readMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
