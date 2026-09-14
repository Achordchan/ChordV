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
} from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { useAgentNodeOnboarding } from "./useAgentNodeOnboarding";
import dialogStyles from "../editors/EditorDialog.module.css";
import styles from "./NodeOnboarding.module.css";
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
  const { stage, result, node, error, hasValidation, creating, regenerating, submit, configure, editInbound, regenerate, retryValidation, refresh, invalidate } =
    useAgentNodeOnboarding(opened, initialNode, onNodeChanged);
  useLayoutEffect(() => { setName(""); setRegion(""); setProvider(""); setTags(""); setPanelInbound(null); }, [opened, initialNode?.id]);
  useLayoutEffect(() => { if (stage === "configure") setPanelInbound(null); }, [stage]);
  const handleClose = () => { invalidate(); onClose(); };
  const create = () => submit({ name: name.trim(), region: region.trim() || undefined,
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
      title={initialNode ? "继续接入节点" : "添加节点"}
      classNames={{content: dialogStyles.content, header: dialogStyles.header, title: dialogStyles.title, body: dialogStyles.body}}
      centered
      size="lg"
      closeOnClickOutside={stage === "form" || stage === "ready" || stage === "failed" || stage === "legacy"}
    >
      <div className={styles.flow} aria-label="接入进度"><span data-active={!["configure", "validating", "ready"].includes(stage) && !(stage === "failed" && hasValidation)}>01 接入服务器</span><span data-active={["configure", "validating", "ready"].includes(stage) || (stage === "failed" && hasValidation)}>02 配置入站</span></div>
      <div className={styles.content}>
      {stage === "form" ? (
        <Stack gap="lg">
          <div><Text fw={600}>填写服务器信息</Text><Text size="sm" c="dimmed" mt={6}>生成安装命令后，在服务器执行；环境就绪后进入入站配置。</Text></div>
          <TextInput label="节点名称" placeholder="如：香港 02" required value={name} onChange={(event) => setName(event.currentTarget.value)} />
          <Group grow>
            <TextInput label="地区" placeholder="如：香港" value={region} onChange={(event) => setRegion(event.currentTarget.value)} />
            <TextInput label="供应商" placeholder="可选" value={provider} onChange={(event) => setProvider(event.currentTarget.value)} />
          </Group>
          <details className={styles.optional}><summary>可选信息</summary><TextInput
            label="标签"
            placeholder="逗号分隔，可选"
            value={tags}
            onChange={(event) => setTags(event.currentTarget.value)}
          /></details>
          {error ? (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{error}</Text>
            </Alert>
          ) : null}
          <Group className={styles.footer} justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              取消
            </Button>
            <Button color="teal.9" loading={creating} disabled={!name.trim()} onClick={() => void create()}>
              生成安装命令
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
        <Stack gap="lg">
          <div className={styles.waiting}><Loader size={20} color="teal.8"/><div><Text fw={600}>等待服务器接入</Text><Text size="sm" c="dimmed" mt={5}>在「{node?.name}」上执行安装命令，完成后自动进入下一步。</Text></div></div>
          <section className={styles.commandSection}>
            <Group justify="space-between" mb="sm"><Text size="sm" fw={550}>安装命令</Text><CopyButton value={installCommand} timeout={2000}>{({copied, copy}) => <Button color="teal.9" variant="light" size="xs" onClick={copy}>{copied ? "已复制" : "复制命令"}</Button>}</CopyButton></Group>
            <Code className={styles.command} block>{installCommand}</Code>
            <Text size="xs" c="dimmed" mt="sm">使用 root 执行 · 有效期至 {new Date(result.registerTokenExpiresAt).toLocaleString()}</Text>
          </section>
          <details className={styles.optional}><summary>安装遇到问题？</summary><Text size="sm" c="dimmed" mb="sm">先检查服务器安装输出。重新生成命令会使旧命令失效。</Text><Button variant="subtle" color="teal.9" size="xs" loading={regenerating} onClick={() => void regenerate()}>重新生成命令</Button></details>
          <Group className={styles.footer} justify="space-between"><Text size="xs" c="dimmed">关闭窗口后可在节点列表继续接入</Text><Button variant="default" onClick={handleClose}>稍后继续</Button></Group>
        </Stack>
      ) : null}

      {stage === "environment" ? <Stack gap="sm">
        <Group gap="xs"><Loader size="sm" /><Text size="sm">Agent 已注册，等待服务启动和环境就绪确认…</Text></Group>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={refresh}>刷新状态</Button><Button onClick={handleClose}>稍后继续</Button></Group>
      </Stack> : null}

      {stage === "configure" && node ? <Stack gap="sm">
        <Text size="sm">服务器「{node.name}」环境已就绪。导入面板中的 VLESS + Reality 入站链接，完成节点绑定。</Text>
        <Text size="xs" c="dimmed">请将面板入站设为不限期、不限流量。</Text>
        <PanelInboundForm onParsed={setPanelInbound} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={handleClose}>稍后继续</Button>
          <Button loading={creating} disabled={!panelInbound} onClick={() => { if (panelInbound) void configure(panelInbound); }}>添加并校验节点</Button>
        </Group>
      </Stack> : null}

      {stage === "validating" ? <Stack gap="sm">
        <Group gap="xs"><Loader size="sm" /><Text size="sm">正在匹配实际入站并核对连接参数…</Text></Group>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={refresh}>刷新状态</Button><Button onClick={handleClose}>关闭</Button></Group>
      </Stack> : null}

      {stage === "legacy" && node ? <Stack gap="sm">
        <Alert color="blue">
          {node.registrationStatus === "agent_ready"
            ? "旧版节点已注册。Go 一键接入不覆盖其现有身份，请按迁移流程处理。"
            : "该旧版节点缺少 Go 接入参数，请重新添加节点并导入面板链接。"}
        </Alert>
        <Group justify="flex-end"><Button onClick={handleClose}>关闭</Button></Group>
      </Stack> : null}

      {stage === "ready" && node ? (
        <Stack gap="sm">
          <Alert color="teal" variant="light">
            <Group gap="xs">
              <Badge color="teal" variant="light" size="sm">校验完成</Badge>
              <Text size="sm">节点「{node.name}」入站校验通过。{node.isActive ? "已启用，可供客户端连接。" : "当前为停用状态，可在节点编辑中启用。"}</Text>
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
              onClick={() => { if (hasValidation) void retryValidation(); else if (node?.registrationStatus === "agent_ready") refresh(); else void regenerate(); }}
            >
              {hasValidation ? "重新校验入站" : node?.registrationStatus === "agent_ready" ? "重新检测环境" : "重新生成安装命令"}
            </Button>
            {hasValidation && <Button variant="light" size="xs" onClick={editInbound}>修改入站参数</Button>}
            <Button variant="default" size="xs" onClick={refresh}>刷新状态</Button>
            <Button variant="default" onClick={handleClose}>
              关闭
            </Button>
          </Group>
        </Stack>
      ) : null}
      </div>
    </Modal>
  );
}
