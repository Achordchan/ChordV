import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import type { AdminNodeRecordDto, CreateAgentNodeInputDto, CreateAgentNodeResultDto } from "@chordv/shared";
import { createAgentNode, fetchAdminNodes, issueNodeRegisterToken } from "../../api/nodes";

type Stage = "form" | "resume" | "awaiting" | "ready" | "failed";
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try { const body = JSON.parse(raw); if (typeof body?.message === "string") return body.message; } catch { /* plain error */ }
  return raw;
}

/** Each open modal owns a session; completed requests from older sessions cannot update its UI. */
export function useAgentNodeOnboarding(opened: boolean, initialNode: AdminNodeRecordDto | null,
  onNodeChanged: (node: AdminNodeRecordDto) => void) {
  const [stage, setStage] = useState<Stage>("form");
  const [result, setResult] = useState<CreateAgentNodeResultDto | null>(null);
  const [node, setNode] = useState<AdminNodeRecordDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
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

  // Registration does not yet publish an SSE event in R1. Reuse the bounded status
  // check: normal 3s, failures back off to 30s, exit on close/new session/ready/15m.
  const pollRegistration = useCallback((nodeId: string, epoch: number) => {
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
        const registered = nodes.find(item => item.id === nodeId);
        if (registered?.registrationStatus === "agent_ready") {
          stopPolling();
          setNode(registered); setStage("ready"); setError(null);
          changed.current(registered);
          notifications.show({ color: "teal", title: "节点已接入", message: `节点「${registered.name}」的 Agent 已完成注册。` });
          return;
        }
      } catch {
        if (!valid()) return;
        interval = Math.min(interval * 2, 30_000);
      }
      if (!valid()) return;
      if (Date.now() >= deadline) {
        stopPolling(); setStage("failed");
        setError("等待超时：15 分钟内未检测到 Agent 注册。请检查 VPS 安装输出，或重新生成安装命令。");
        return;
      }
      timer.current = window.setTimeout(() => void tick(), Math.min(interval, deadline - Date.now()));
    };
    timer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
  }, [current, stopPolling]);

  useLayoutEffect(() => {
    invalidate();
    active.current = opened;
    setResult(null); setNode(opened ? initialNode : null); setError(null);
    setCreating(false); setRegenerating(false);
    setStage(opened && initialNode ? (initialNode.registrationStatus === "agent_ready" ? "ready" : "resume") : "form");
    if (opened && initialNode?.registrationStatus === "pending_register") pollRegistration(initialNode.id, session.current);
    return invalidate;
    // Node object refreshes must not invalidate the same open session.
  }, [opened, initialNode?.id, invalidate, pollRegistration]);

  const submit = useCallback(async (input: CreateAgentNodeInputDto) => {
    if (!active.current || requestBusy.current || !input.name.trim()) return;
    const epoch = session.current;
    requestBusy.current = true; setCreating(true); setError(null);
    try {
      const created = await createAgentNode(input);
      // Creation may commit after close. Refresh the parent list, but never reopen
      // the old modal or show its one-time credential in a new session.
      changed.current(created.node);
      if (!current(epoch)) return;
      setNode(created.node); setResult(created); setStage("awaiting");
      pollRegistration(created.node.id, epoch);
    } catch (error) {
      if (!current(epoch)) return;
      setError(errorMessage(error)); setStage("form");
    } finally {
      if (current(epoch)) { requestBusy.current = false; setCreating(false); }
    }
  }, [current, pollRegistration]);

  const regenerate = useCallback(async () => {
    if (!node || !active.current || requestBusy.current) return;
    const epoch = session.current;
    requestBusy.current = true; stopPolling(); setRegenerating(true); setError(null);
    try {
      const fresh = await issueNodeRegisterToken(node.id);
      if (!current(epoch)) return;
      setResult({ node, registerToken: fresh.token, registerTokenExpiresAt: fresh.expiresAt });
      setStage("awaiting"); pollRegistration(node.id, epoch);
      notifications.show({ color: "teal", title: "安装命令已重新生成", message: "旧命令已作废，请使用新的安装命令。" });
    } catch (error) {
      if (!current(epoch)) return;
      setResult(null); setStage("failed"); setError(errorMessage(error));
      pollRegistration(node.id, epoch);
    } finally {
      if (current(epoch)) { requestBusy.current = false; setRegenerating(false); }
    }
  }, [node, current, pollRegistration, stopPolling]);

  return { stage, result, node, error, creating, regenerating, submit, regenerate, invalidate };
}
