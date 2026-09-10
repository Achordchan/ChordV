import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { deployNodeInbound, fetchAdminNodes, fetchNodeCommandOutcome } from "../../api/nodes";

type Stage = "idle" | "queued" | "done" | "failed";
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

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
 * invalidates on unmount AND on node change — a late response or a late poll
 * from an old session can never mutate state, notify, or unlock a newer
 * request's busy flag.
 */
export function useInboundDeployment(nodeId: string | null, onNodeChanged: (node: AdminNodeRecordDto) => void) {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [queuedRevision, setQueuedRevision] = useState<string | null>(null);
  const session = useRef(0), pollEpoch = useRef(0);
  const active = useRef(false), requestBusy = useRef(false);
  const timer = useRef<number | null>(null);
  const changed = useRef(onNodeChanged);
  changed.current = onNodeChanged;
  const current = useCallback((epoch: number) => active.current && session.current === epoch, []);
  const stopPolling = useCallback(() => {
    pollEpoch.current++;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const invalidate = useCallback(() => {
    session.current++;
    active.current = false;
    requestBusy.current = false;
    stopPolling();
  }, [stopPolling]);

  // Completion does not publish an admin event; poll the bounded status check
  // like registration does: normal 3s, failures back off to 30s, exit on
  // close/node switch/terminal outcome/5m. The QUEUED COMMAND's own outcome
  // decides success — a higher node-level applied revision alone does not:
  // this deployment can fail while a later administrator's succeeds, pushing
  // the revision past this command's target (worst for key rotation: the
  // rotation never happened but the revision moved).
  const pollOutcome = useCallback((nodeId: string, commandId: string, targetRevision: string, epoch: number) => {
    stopPolling();
    const poll = pollEpoch.current;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let interval = POLL_INTERVAL_MS;
    const valid = () => current(epoch) && pollEpoch.current === poll;
    const fail = (message: string) => {
      stopPolling(); setStage("failed"); setError(message);
    };
    const succeed = (record: { id: string; name?: string } | undefined) => {
      stopPolling();
      setStage("done"); setError(null);
      if (record) changed.current(record as AdminNodeRecordDto);
      notifications.show({ color: "teal", title: "入站操作完成", message: `节点「${record?.name ?? nodeId}」的入站命令已完成，连接参数已更新；请按所选模式进行验收。` });
    };
    const tick = async () => {
      if (!valid()) return;
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
        // The WHOLE tick succeeded (outcome + node list): only now may a
        // failing next round back off from the normal interval — resetting
        // after the outcome alone made a failing node-list endpoint retry at
        // 3s→6s→3s→6s forever instead of backing off to 30s.
        interval = POLL_INTERVAL_MS;
      } catch {
        if (!valid()) return;
        interval = Math.min(interval * 2, 30_000);
      }
      if (!valid()) return;
      if (Date.now() >= deadline) {
        fail("等待超时：5 分钟内未确认部署完成。命令仍在队列中，Agent 恢复后会继续执行；可稍后刷新查看结果。");
        return;
      }
      timer.current = window.setTimeout(() => void tick(), Math.min(interval, deadline - Date.now()));
    };
    timer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
  }, [current, stopPolling]);

  useLayoutEffect(() => {
    invalidate();
    active.current = nodeId !== null;
    setStage("idle"); setError(null); setDeploying(false); setQueuedRevision(null);
    return invalidate;
    // Node object refreshes (same id) must not invalidate an in-flight poll.
  }, [nodeId, invalidate]);

  const deploy = useCallback(async (node: AdminNodeRecordDto, payload: Record<string, unknown>, expectedAppliedRevision: string) => {
    if (!active.current || requestBusy.current) return false;
    const epoch = session.current;
    requestBusy.current = true; setDeploying(true); setError(null); setStage("queued"); setQueuedRevision(null);
    try {
      const command = await deployNodeInbound(node.id, payload, expectedAppliedRevision);
      // Queuing may commit after the drawer closed or switched nodes: refresh
      // nothing, poll nothing, notify nothing in the new session.
      if (!current(epoch)) return false;
      setQueuedRevision(command.targetRevision);
      pollOutcome(node.id, command.commandId, command.targetRevision, epoch);
      return true;
    } catch (error) {
      if (!current(epoch)) return false;
      setStage("failed"); setError(errorMessage(error));
      // A rejected enqueue often means the node moved underneath a STALE
      // browser (another admin deployed; no admin event ever told us). Fetch
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
  }, [current, pollOutcome]);

  return { stage, error, deploying, queuedRevision, deploy };
}
