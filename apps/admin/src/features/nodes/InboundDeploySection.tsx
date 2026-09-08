import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Loader, Modal, NumberInput, Paper, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { IconKey, IconRocket } from "@tabler/icons-react";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { fetchNodeInboundSpec } from "../../api/nodes";
import { buildInboundDeployPayload, splitCsv, type InboundDeployFormState } from "../../utils/admin-node-payloads";
import { useInboundDeployment } from "./useInboundDeployment";

const DEFAULT_SNI = "www.microsoft.com";

type SectionProps = {
  node: AdminNodeRecordDto;
  onNodeChanged: (node: AdminNodeRecordDto) => void;
};

function stringField(spec: Record<string, unknown> | null, key: string): string | undefined {
  return typeof spec?.[key] === "string" ? spec[key] as string : undefined;
}

function specErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try { const body = JSON.parse(raw); if (typeof body?.message === "string") return body.message; } catch { /* plain error */ }
  return raw;
}

/**
 * Lifecycle of loading the applied deployment's COMPLETE spec. "loaded" with a
 * null spec means no ENSURE_INBOUND ever applied (parameters imported from a
 * panel) — the lossy node record is then the only source. "loading" and
 * "error" mean the truth is UNKNOWN: reissue editing is gated on "loaded",
 * because falling back to the node record from either would submit a spec
 * that drops SNIs and replaces the custom destination of an existing
 * deployment.
 */
type SpecLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; spec: Record<string, unknown> | null }
  | { status: "error"; message: string };

/**
 * R2-B: the admin half of ENSURE_INBOUND. Shows the Reality parameters the
 * agent reported back (the values every client config is generated from) and
 * queues deployments — the initial one that makes the node activatable, and
 * re-issues after a port/SNI change. Key rotation is exposed as the
 * destructive operation it is: it invalidates every subscription already
 * handed out for this node.
 */
export function InboundDeploySection(props: SectionProps) {
  const { node } = props;
  const deployment = useInboundDeployment(node.id, props.onNodeChanged);
  const [modalOpened, setModalOpened] = useState(false);
  const [form, setForm] = useState<InboundDeployFormState>({ listenPort: 443, serverNamesCsv: DEFAULT_SNI, dest: "", rotateKeys: false });
  const [confirmedRotation, setConfirmedRotation] = useState(false);
  const [specLoad, setSpecLoad] = useState<SpecLoad>({ status: "idle" });
  const [specRetry, setSpecRetry] = useState(0);
  const loadEpoch = useRef(0);
  // The applied revision the open form was built from. A change underneath
  // (another administrator's deployment completing) means the form's
  // port/SNI/dest snapshot is stale; submitting it would roll the newer
  // deployment back or reset its tag.
  const [formRevision, setFormRevision] = useState<string | null>(null);

  const deployed = node.serverPort > 0 && Boolean(node.realityPublicKey?.trim());
  // First deployment has no keys to rotate; the option only exists where it
  // means something — and where it is destructive.
  const canRotate = deployed;

  // Loading is epoch-guarded: only the MOST RECENT load may publish state —
  // a response landing after a node switch or a spec refresh (new applied
  // revision) must not overwrite the newer load's result.
  const loadSpec = useCallback(() => {
    const epoch = ++loadEpoch.current;
    if (!deployed) { setSpecLoad({ status: "idle" }); return; }
    setSpecLoad({ status: "loading" });
    fetchNodeInboundSpec(node.id)
      .then((result) => { if (loadEpoch.current === epoch) setSpecLoad({ status: "loaded", spec: result.spec }); })
      .catch((error) => { if (loadEpoch.current === epoch) setSpecLoad({ status: "error", message: specErrorMessage(error) }); });
  }, [node.id, deployed]);

  // Refresh when the APPLIED revision moves: after a reissue completes, the
  // refreshed node record carries the new parameters while neither node.id
  // nor `deployed` changed — without this dependency the next modal would
  // prefill the PREVIOUS deployment's spec and a subsequent reissue or key
  // rotation would silently roll the successful change back. The reissue
  // gate below stays disabled until the refreshed spec has loaded.
  useEffect(() => {
    loadSpec();
  }, [loadSpec, node.inboundAppliedRevision, specRetry]);

  const currentSpec = specLoad.status === "loaded" ? specLoad.spec : null;
  // Reissue editing requires the CURRENT spec; a first deployment needs none.
  const reissueReady = !deployed || specLoad.status === "loaded";

  useEffect(() => {
    if (!modalOpened) return;
    const specServerNames = Array.isArray(currentSpec?.serverNames) ? (currentSpec?.serverNames as unknown[]).filter((item): item is string => typeof item === "string") : [];
    setForm({
      listenPort: typeof currentSpec?.listenPort === "number" ? currentSpec.listenPort : (deployed ? node.serverPort : 443),
      // The COMPLETE deployed list: an untouched field reissues it unchanged
      // instead of dropping every SNI past the first. Falls back to the node
      // record's single serverName when no applied job exists.
      serverNamesCsv: specServerNames.length > 0 ? specServerNames.join(", ") : (node.serverName?.trim() || DEFAULT_SNI),
      // The deployed target verbatim (it may be a custom host/port); empty on
      // first deploy, where the builder derives from the first SNI.
      dest: stringField(currentSpec, "dest") ?? "",
      rotateKeys: false
    });
    setConfirmedRotation(false);
    setFormRevision(node.inboundAppliedRevision ?? "0");
    // Form defaults snapshot the node and the loaded spec at open time;
    // refreshes mid-modal must not overwrite what the operator is typing.
  }, [modalOpened]);

  const serverNames = splitCsv(form.serverNamesCsv);
  // A revision change under an open form invalidates its snapshot: the fields
  // were captured against the PREVIOUS deployment, and mixing them with
  // node-record fallbacks or the newer spec's preserved fields could roll the
  // newer deployment back. Block submission until the operator reopens the
  // form against the current spec.
  const revisionChangedUnderneath = formRevision !== null && (node.inboundAppliedRevision ?? "0") !== formRevision;
  const canSubmit = serverNames.length > 0 && (!form.rotateKeys || confirmedRotation) && !revisionChangedUnderneath;

  async function submitDeploy() {
    if (!canSubmit) return;
    // A reissue must not silently reset the fields this form does not edit:
    // preserve the deployed flow/fingerprint/spiderX/inboundTag from the
    // applied job's spec so already-distributed client configurations keep
    // connecting. A FIRST deployment sends none of them and takes the
    // control-plane defaults.
    const queued = await deployment.deploy(node, buildInboundDeployPayload({
      ...form,
      preserve: deployed
        ? {
          flow: stringField(currentSpec, "flow") ?? node.flow ?? "",
          fingerprint: stringField(currentSpec, "fingerprint") ?? node.fingerprint ?? "",
          spiderX: stringField(currentSpec, "spiderX") ?? node.spiderX ?? "",
          inboundTag: stringField(currentSpec, "inboundTag")
        }
        : undefined
    }));
    if (queued) setModalOpened(false);
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center" wrap="wrap">
        <Text fw={600}>Reality 入站</Text>
        <Button
          size="xs"
          variant={deployed ? "light" : "filled"}
          color={deployed ? "blue" : "teal"}
          leftSection={<IconRocket size={14} />}
          disabled={deployment.stage === "queued" || !reissueReady}
          loading={deployed && specLoad.status === "loading"}
          onClick={() => setModalOpened(true)}
        >
          {deployed ? "调整参数 / 重新下发" : "部署入站"}
        </Button>
      </Group>

      {deployed ? (
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <ParamItem label="接入地址" value={`${node.serverHost}:${node.serverPort}`} />
          <ParamItem label="SNI" value={node.serverName} />
          <ParamItem label="Reality 公钥" value={node.realityPublicKey ?? ""} mono />
          <ParamItem label="shortId" value={node.shortId} mono />
          <ParamItem label="flow" value={node.flow || "无"} />
          <ParamItem label="fingerprint" value={node.fingerprint || "-"} />
          <ParamItem label="spiderX" value={node.spiderX || "/"} mono />
          <ParamItem label="部署 revision" value={node.inboundAppliedRevision ?? "0"} />
        </SimpleGrid>
      ) : (
        <Alert color="gray" variant="light" icon={<IconKey size={18} />}>
          尚未部署入站：节点仍是占位符（Agent 注册完成后等待下发）。部署 Reality 入站并回填参数后，节点才能激活并分配给订阅。
        </Alert>
      )}

      {deployed && specLoad.status === "loading" ? (
        <Alert color="blue" variant="light">
          <Group gap="sm" wrap="nowrap">
            <Loader size="xs" />
            <Text size="sm">正在读取当前部署规格，重新下发将在读取完成后开放。</Text>
          </Group>
        </Alert>
      ) : null}
      {deployed && specLoad.status === "error" ? (
        <Alert color="red" variant="light" title="读取当前部署规格失败">
          <Group gap="sm" justify="space-between" wrap="wrap">
            <Text size="sm">{specLoad.message || "重新下发已停用：此时提交会退化为不完整的节点记录参数（丢失多 SNI 与自定义回退目标）。"}</Text>
            <Button size="xs" variant="light" color="red" onClick={() => setSpecRetry((count) => count + 1)}>重试</Button>
          </Group>
        </Alert>
      ) : null}

      {deployment.stage === "queued" ? (
        <Alert color="blue" variant="light">
          <Group gap="sm" wrap="nowrap">
            <Loader size="xs" />
            <Text size="sm">
              已下发部署命令{deployment.queuedRevision ? `（revision ${deployment.queuedRevision}）` : ""}，正在等待 Agent 执行…
            </Text>
          </Group>
        </Alert>
      ) : null}
      {deployment.stage === "failed" && deployment.error ? (
        <Alert color="red" variant="light" title="部署未完成">{deployment.error}</Alert>
      ) : null}

      <Modal opened={modalOpened} onClose={() => setModalOpened(false)} title={deployed ? "重新下发 Reality 入站" : "部署 Reality 入站"} centered>
        <Stack gap="md">
          <Alert color={form.rotateKeys ? "red" : "blue"} variant="light">
            {form.rotateKeys
              ? "轮换会让该节点已发出的所有订阅立即失效，所有客户端必须重新获取订阅配置。仅在密钥疑似泄露时使用。"
              : "命令将进入队列，由节点上的 Agent 执行：部署 VLESS+Reality 入站并回填连接参数。私钥只在 VPS 上生成，不会离开机器。"}
          </Alert>
          {revisionChangedUnderneath ? (
            <Alert color="red" variant="light" title="节点部署已在此表单打开期间发生变化">
              表单中的参数是对上一份部署的快照，为避免覆盖新部署（或重置其 inboundTag），提交已停用：请关闭并重新打开表单以加载当前参数。
            </Alert>
          ) : null}
          <NumberInput
            label="监听端口"
            value={form.listenPort}
            min={1}
            max={65535}
            onChange={(value) => setForm((current) => ({ ...current, listenPort: typeof value === "number" ? value : "" }))}
          />
          <TextInput
            label="SNI 伪装域名（多个用逗号分隔）"
            value={form.serverNamesCsv}
            placeholder={DEFAULT_SNI}
            error={serverNames.length === 0 ? "SNI 不能为空" : null}
            description="重新下发时保持完整列表：删除其中一个 SNI 会让用它连接的客户端立即失效。"
            onChange={(event) => { const value = event.currentTarget.value; setForm((current) => ({ ...current, serverNamesCsv: value })); }}
          />
          <TextInput
            label="回退目标（dest）"
            value={form.dest}
            placeholder={`${serverNames[0] || DEFAULT_SNI}:443`}
            description={`留空则自动使用「${serverNames[0] || DEFAULT_SNI}:443」：Reality 的回退目标必须能为所选 SNI 出示有效证书，SNI 与目标不配套时握手会失败。`}
            onChange={(event) => { const value = event.currentTarget.value; setForm((current) => ({ ...current, dest: value })); }}
          />
          {deployed ? (
            <Text size="xs" c="dimmed">
              重新下发会保持当前部署的 flow / fingerprint / spiderX / inboundTag 不变；本次未改变端口、SNI 与目标时，助手按同规格处理、不会重启 Xray。
            </Text>
          ) : null}
          {canRotate ? (
            <>
              <Checkbox
                checked={form.rotateKeys}
                onChange={(event) => { const checked = event.currentTarget.checked; setForm((current) => ({ ...current, rotateKeys: checked })); setConfirmedRotation(false); }}
                label="轮换 Reality 密钥（破坏性操作）"
                color="red"
              />
              {form.rotateKeys ? (
                <Checkbox
                  checked={confirmedRotation}
                  onChange={(event) => setConfirmedRotation(event.currentTarget.checked)}
                  label="我了解该节点已发出的所有订阅将立即失效，所有客户端需要重新获取订阅。"
                  color="red"
                />
              ) : null}
            </>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpened(false)}>取消</Button>
            <Button color="teal" disabled={!canSubmit} loading={deployment.deploying} onClick={() => void submitDeploy()}>
              下发部署
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function ParamItem(props: { label: string; value: string; mono?: boolean }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap={2}>
        <Text size="xs" c="dimmed">{props.label}</Text>
        <Text size="sm" fw={600} style={props.mono ? { fontFamily: "var(--mantine-font-family-monospace)", wordBreak: "break-all" } : undefined}>
          {props.value}
        </Text>
      </Stack>
    </Paper>
  );
}
