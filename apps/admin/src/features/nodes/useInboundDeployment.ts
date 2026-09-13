import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { subscribeAdminRuntimeEvents } from "../../api/client";
import { deployNodeInbound, fetchAdminNodes, fetchNodeCommandOutcome } from "../../api/nodes";

type Stage = "idle" | "queued" | "done" | "failed";
const OBSERVATION_TIMEOUT_MS = 5 * 60 * 1000;

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try { const body = JSON.parse(raw); if (typeof body?.message === "string") return body.message; } catch { /* plain error */ }
  return raw;
}

/**
 * Queues an ENSURE_INBOUND command and watches for its completion: the queue
 * response is the COMMAND (with its targetRevision), not the outcome — the
 * agent deploys seconds later and reports back, and completion is observable
 * as the node record's inboundAppliedRevision reaching that revision.
 *
 * Same session discipline as useAgentNodeOnboarding: the section lives in the
 * node drawer, one component instance across node switches, so the epoch
 * invalidates on unmount AND on node change — a late request or event response
 * from an old session can never mutate state, notify, or unlock a newer
 * request's busy flag.
 */
export function useInboundDeployment(nodeId: string | null, onNodeChanged: (node: AdminNodeRecordDto) => void) {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [queuedRevision, setQueuedRevision] = useState<string | null>(null);
  const session = useRef(0), watchEpoch = useRef(0);
  const active = useRef(false), requestBusy = useRef(false);
  const timer = useRef<number | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const refreshOutcome = useRef<(() => void) | null>(null);
  const changed = useRef(onNodeChanged);
  changed.current = onNodeChanged;
  const current = useCallback((epoch: number) => active.current && session.current === epoch, []);
  const stopWatching = useCallback(() => {
    watchEpoch.current++;
    unsubscribe.current?.(); unsubscribe.current = null;
    refreshOutcome.current = null;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const invalidate = useCallback(() => {
    session.current++;
    active.current = false;
    requestBusy.current = false;
    stopWatching();
  }, [stopWatching]);

  // Read the exact command outcome after relevant SSE events, including the
  // stream-opening resync. A later node revision alone never proves success.
  const watchOutcome = useCallback((nodeId: string, commandId: string, targetRevision: string, epoch: number) => {
    stopWatching();
    const watch = watchEpoch.current;
    let busy = false, dirty = false;
    const valid = () => current(epoch) && watchEpoch.current === watch;
    const fail = (message: string) => {
      stopWatching(); setStage("failed"); setError(message);
    };
    const succeed = (record: { id: string; name?: string } | undefined) => {
      stopWatching();
      setStage("done"); setError(null);
      if (record) changed.current(record as AdminNodeRecordDto);
      notifications.show({ color: "teal", title: "入站操作完成", message: `节点「${record?.name ?? nodeId}」的入站命令已完成，连接参数已更新；请按所选模式进行验收。` });
    };
    const tick = async () => {
      if (!valid()) return;
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const outcome = await fetchNodeCommandOutcome(nodeId, commandId);
        if (!valid()) return;
        if (outcome === null) {
          fail("命令记录不存在（可能已被清理），无法确认部署结果；请刷新节点查看当前参数。");
          return;
        }
        if (outcome.status === "completed") {
          const nodes = await fetchAdminNodes();
          if (!valid()) return;
          succeed(nodes.find(item => item.id === nodeId));
          return;
        }
        if (outcome.status === "failed" || outcome.status === "cancelled") {
          fail(outcome.status === "cancelled"
            ? "部署命令已被取消。"
            : `部署失败：${outcome.lastError ?? "Agent 未提供原因"}`);
          return;
        }
        // Still pending/running: a STRICTLY higher applied revision means a
        // LATER deployment finished first — this command's change (e.g. a key
        // rotation) never took effect, and the agent's stale-revision guard
        // will reject it if it ever runs. Supersession is not success.
        const nodes = await fetchAdminNodes();
        if (!valid()) return;
        const record = nodes.find(item => item.id === nodeId);
        if (record && BigInt(record.inboundAppliedRevision ?? "0") > BigInt(targetRevision)) {
          // The revision just seen can only exist because the LATER command
          // committed, and the agent executes commands in order — so THIS
          // command's outcome is already terminal. It may have completed
          // between the two reads above: re-read it before claiming the
          // change never happened (telling an operator a rotation did not
          // happen when it did is the false negative this poll avoids).
          const finalOutcome = await fetchNodeCommandOutcome(nodeId, commandId);
          if (!valid()) return;
          if (finalOutcome?.status === "completed") { succeed(record); return; }
          if (finalOutcome?.status === "failed" || finalOutcome?.status === "cancelled") {
            fail(finalOutcome.status === "cancelled"
              ? "部署命令已被取消。"
              : `部署失败：${finalOutcome.lastError ?? "Agent 未提供原因"}`);
            return;
          }
          fail(`本次下发已被更新的部署取代（revision ${record.inboundAppliedRevision ?? "0"} 越过本命令的 ${targetRevision}），未生效；请重新打开表单基于当前参数操作。`);
          return;
        }
        setError(null);
      } catch (reason) {
        if (valid()) setError(errorMessage(reason));
      } finally {
        busy = false;
        if (dirty && valid()) { dirty = false; void tick(); }
      }
    };
    refreshOutcome.current = () => { void tick(); };
    unsubscribe.current = subscribeAdminRuntimeEvents(event => {
      if (event.type === "sync_queue_updated" || (event.type === "node_access_updated" && (!event.nodeId || event.nodeId === nodeId))) void tick();
    });
    // One deadline, not a query loop. Expiry does not cancel the server task.
    timer.current = window.setTimeout(() => {
      if (valid()) fail("5 分钟内未确认入站操作结果。后台任务不会因此取消，请刷新节点状态后继续处理。");
    }, OBSERVATION_TIMEOUT_MS);
    void tick();
  }, [current, stopWatching]);

  useLayoutEffect(() => {
    invalidate();
    active.current = nodeId !== null;
    setStage("idle"); setError(null); setDeploying(false); setQueuedRevision(null);
    return invalidate;
    // Node object refreshes (same id) must not invalidate an in-flight observation.
  }, [nodeId, invalidate]);

  const deploy = useCallback(async (node: AdminNodeRecordDto, payload: Record<string, unknown>, expectedAppliedRevision: string) => {
    if (!active.current || requestBusy.current) return false;
    const epoch = session.current;
    requestBusy.current = true; setDeploying(true); setError(null); setStage("queued"); setQueuedRevision(null);
    try {
      const command = await deployNodeInbound(node.id, payload, expectedAppliedRevision);
      // Queuing may commit after the drawer closed or switched nodes: refresh
      // nothing, observe nothing, notify nothing in the new session.
      if (!current(epoch)) return false;
      setQueuedRevision(command.targetRevision);
      watchOutcome(node.id, command.commandId, command.targetRevision, epoch);
      return true;
    } catch (error) {
      if (!current(epoch)) return false;
      setStage("failed"); setError(errorMessage(error));
      // A rejected enqueue often means the node moved underneath a STALE
      // browser (another admin deployed; the local snapshot missed the change). Fetch
      // the fresh record so the drawer re-renders on current truth — the open
      // form's revision gate then blocks until the operator reviews it.
      fetchAdminNodes()
        .then((nodes) => {
          if (!current(epoch)) return;
          const record = nodes.find((item) => item.id === node.id);
          if (record) changed.current(record);
        })
        .catch(() => undefined);
      return false;
    } finally {
      if (current(epoch)) { requestBusy.current = false; setDeploying(false); }
    }
  }, [current, watchOutcome]);

  return { stage, error, deploying, queuedRevision, deploy, refresh: () => refreshOutcome.current?.() };
}
