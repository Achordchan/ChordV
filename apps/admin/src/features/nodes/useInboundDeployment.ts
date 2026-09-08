import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { deployNodeInbound, fetchAdminNodes } from "../../api/nodes";

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
  // close/node switch/completion/5m.
  const pollCompletion = useCallback((nodeId: string, targetRevision: string, epoch: number) => {
    stopPolling();
    const poll = pollEpoch.current;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let interval = POLL_INTERVAL_MS;
    const valid = () => current(epoch) && pollEpoch.current === poll;
    const tick = async () => {
      if (!valid()) return;
      try {
        const nodes = await fetchAdminNodes();
        if (!valid()) return;
        interval = POLL_INTERVAL_MS;
        const record = nodes.find(item => item.id === nodeId);
        if (record && BigInt(record.inboundAppliedRevision ?? "0") >= BigInt(targetRevision)) {
          stopPolling();
          setStage("done"); setError(null);
          changed.current(record);
          notifications.show({ color: "teal", title: "入站部署完成", message: `节点「${record.name}」的 Reality 入站已部署，连接参数已回填。` });
          return;
        }
      } catch {
        if (!valid()) return;
        interval = Math.min(interval * 2, 30_000);
      }
      if (!valid()) return;
      if (Date.now() >= deadline) {
        stopPolling(); setStage("failed");
        setError("等待超时：5 分钟内未确认部署完成。命令仍在队列中，Agent 恢复后会继续执行；可稍后刷新查看结果。");
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

  const deploy = useCallback(async (node: AdminNodeRecordDto, payload: Record<string, unknown>) => {
    if (!active.current || requestBusy.current) return false;
    const epoch = session.current;
    requestBusy.current = true; setDeploying(true); setError(null); setStage("queued"); setQueuedRevision(null);
    try {
      const command = await deployNodeInbound(node.id, payload);
      // Queuing may commit after the drawer closed or switched nodes: refresh
      // nothing, poll nothing, notify nothing in the new session.
      if (!current(epoch)) return false;
      setQueuedRevision(command.targetRevision);
      pollCompletion(node.id, command.targetRevision, epoch);
      return true;
    } catch (error) {
      if (!current(epoch)) return false;
      setStage("failed"); setError(errorMessage(error));
      return false;
    } finally {
      if (current(epoch)) { requestBusy.current = false; setDeploying(false); }
    }
  }, [current, pollCompletion]);

  return { stage, error, deploying, queuedRevision, deploy };
}
