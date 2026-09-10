import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AdminNodeRecordDto, CreateAgentNodeInputDto, CreateAgentNodeResultDto } from "@chordv/shared";
import { createAgentNode, deployNodeInbound, fetchAgentOnboarding, issueNodeRegisterToken, retryAgentOnboarding } from "../../api/nodes";
import { subscribeAdminRuntimeEvents } from "../../api/client";

type Stage = "form" | "resume" | "awaiting" | "environment" | "configure" | "validating" | "ready" | "failed" | "legacy";
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try { const body = JSON.parse(raw); if (typeof body?.message === "string") return body.message; } catch { /* plain error */ }
  return raw;
}

/** Each modal session owns its requests and event subscription. Reconnection
 * snapshots close missed-event gaps; no registration or command polling. */
export function useAgentNodeOnboarding(opened: boolean, initialNode: AdminNodeRecordDto | null,
  onNodeChanged: (node: AdminNodeRecordDto) => void) {
  const [stage, setStage] = useState<Stage>("form");
  const [result, setResult] = useState<CreateAgentNodeResultDto | null>(null);
  const [node, setNode] = useState<AdminNodeRecordDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasValidation, setHasValidation] = useState(false);
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const session = useRef(0), watchEpoch = useRef(0);
  const active = useRef(false), requestBusy = useRef(false);
  const resultAvailable = useRef(false);
  const unsubscribe = useRef<(() => void) | null>(null);
  const deadline = useRef<number | null>(null);
  const changed = useRef(onNodeChanged);
  changed.current = onNodeChanged;
  const current = useCallback((epoch: number) => active.current && session.current === epoch, []);
  const stopWatching = useCallback(() => {
    watchEpoch.current++;
    unsubscribe.current?.(); unsubscribe.current = null;
    if (deadline.current !== null) window.clearTimeout(deadline.current);
    deadline.current = null;
  }, []);
  const invalidate = useCallback(() => {
    session.current++; active.current = false; requestBusy.current = false; resultAvailable.current = false; stopWatching();
  }, [stopWatching]);

  const watchRegistration = useCallback((nodeId: string, epoch: number, preservePendingError = false) => {
    stopWatching();
    const watch = watchEpoch.current;
    const valid = () => current(epoch) && watchEpoch.current === watch;
    let busy = false, dirty = false;
    const refresh = async () => {
      if (!valid()) return;
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const status = await fetchAgentOnboarding(nodeId);
        if (!valid()) return;
        const registered = status.node;
        setNode(registered); changed.current(registered);
        setHasValidation(Boolean(status.spec));
        if (status.mode === "legacy") {
          resultAvailable.current = false;
          setResult(null); setStage("legacy"); setError(null); stopWatching(); return;
        }
        if (registered.registrationStatus !== "agent_ready") {
          if (!preservePendingError) { setStage(resultAvailable.current ? "awaiting" : "resume"); setError(null); }
          return;
        }
        resultAvailable.current = false;
        setResult(null);
        if (status.mode === "environment") {
          setStage(status.environmentReady ? "configure" : "environment"); setError(null);
          if (status.environmentReady && deadline.current !== null) { window.clearTimeout(deadline.current); deadline.current = null; }
          return;
        }
        if (!status.spec || !status.command) {
          setStage("failed"); setError("缺少入站校验任务，请在节点控制器重新导入参数并校验。");
        } else if (status.command.status === "completed" && registered.inboundAppliedRevision === status.command.targetRevision) {
          setStage("ready"); setError(null); stopWatching();
        } else if (["failed", "cancelled", "completed"].includes(status.command.status)) {
          setStage("failed"); setError(status.command.lastError || "本次校验结果已过期，请刷新后重新校验。");
        } else {
          setStage("validating"); setError(null);
        }
      } catch (error) {
        if (valid()) setError(errorMessage(error));
      } finally {
        busy = false;
        // An event received during a read requests one follow-up snapshot; this
        // is event coalescing, never a timer-driven status loop.
        if (dirty && valid()) { dirty = false; void refresh(); }
      }
    };
    unsubscribe.current = subscribeAdminRuntimeEvents(event => {
      // AdminRuntimeEventsService sends an unscoped node_access_updated every
      // time stream() opens, including reconnects with no replay history.
      if (event.type === "node_access_updated" && (!event.nodeId || event.nodeId === nodeId)) void refresh();
    });
    deadline.current = window.setTimeout(() => {
      if (!valid()) return;
      stopWatching(); setStage("failed");
      setError("等待已超过 15 分钟，请检查 VPS 安装输出，再点击刷新状态。");
    }, 15 * 60 * 1000);
    void refresh();
  }, [current, stopWatching]);

  useLayoutEffect(() => {
    invalidate(); active.current = opened;
    setResult(null); setNode(opened ? initialNode : null); setError(null);
    setCreating(false); setRegenerating(false); setHasValidation(false);
    setStage(opened && initialNode ? (initialNode.registrationStatus === "agent_ready" ? "environment" : "resume") : "form");
    if (opened && initialNode) watchRegistration(initialNode.id, session.current);
    return invalidate;
  }, [opened, initialNode?.id, invalidate, watchRegistration]);

  const submit = useCallback(async (input: CreateAgentNodeInputDto) => {
    if (!active.current || requestBusy.current || !input.name.trim()) return;
    const epoch = session.current;
    requestBusy.current = true; setCreating(true); setError(null);
    try {
      const created = await createAgentNode(input);
      changed.current(created.node);
      if (!current(epoch)) return;
      resultAvailable.current = true;
      setNode(created.node); setResult(created); setStage("awaiting");
      watchRegistration(created.node.id, epoch);
    } catch (error) {
      if (!current(epoch)) return;
      setError(errorMessage(error)); setStage("form");
    } finally {
      if (current(epoch)) { requestBusy.current = false; setCreating(false); }
    }
  }, [current, watchRegistration]);

  const regenerate = useCallback(async () => {
    if (!node || !active.current || requestBusy.current) return;
    const epoch = session.current;
    requestBusy.current = true; stopWatching(); setRegenerating(true); setError(null);
    try {
      const fresh = await issueNodeRegisterToken(node.id);
      if (!current(epoch)) return;
      resultAvailable.current = true;
      setResult({ node, registerToken: fresh.token, registerTokenExpiresAt: fresh.expiresAt });
      setStage("awaiting"); watchRegistration(node.id, epoch);
    } catch (error) {
      if (!current(epoch)) return;
      resultAvailable.current = false;
      setResult(null); setStage("failed"); setError(errorMessage(error));
      // Observe a concurrent registration without hiding the failed token
      // mutation. A user-triggered refresh can explicitly resume waiting.
      watchRegistration(node.id, epoch, true);
    } finally {
      if (current(epoch)) { requestBusy.current = false; setRegenerating(false); }
    }
  }, [node, current, watchRegistration, stopWatching]);

  const retryValidation = useCallback(async () => {
    if (!node || !active.current || requestBusy.current) return;
    const epoch = session.current;
    requestBusy.current = true; setRegenerating(true); setError(null);
    try {
      await retryAgentOnboarding(node.id);
      if (!current(epoch)) return;
      setStage("validating"); watchRegistration(node.id, epoch);
    } catch (error) {
      if (current(epoch)) setError(errorMessage(error));
    } finally {
      if (current(epoch)) { requestBusy.current = false; setRegenerating(false); }
    }
  }, [node, current, watchRegistration]);

  const configure = useCallback(async (payload: Record<string, unknown>) => {
    if (!node || !active.current || requestBusy.current || stage !== "configure") return;
    const epoch = session.current;
    requestBusy.current = true; setCreating(true); setError(null); stopWatching();
    try {
      await deployNodeInbound(node.id, payload, node.inboundAppliedRevision ?? "0");
      if (!current(epoch)) return;
      setStage("validating"); watchRegistration(node.id, epoch);
    } catch (error) {
      if (current(epoch)) { setStage("configure"); setError(errorMessage(error)); }
    } finally {
      if (current(epoch)) { requestBusy.current = false; setCreating(false); }
    }
  }, [node, stage, current, watchRegistration, stopWatching]);

  const editInbound = () => {
    if (!node || requestBusy.current || !active.current) return;
    stopWatching(); setError(null); setStage("configure");
  };
  const refresh = () => { if (node && active.current) watchRegistration(node.id, session.current); };
  return { stage, result, node, error, hasValidation, creating, regenerating, submit, configure, editInbound, regenerate, retryValidation, refresh, invalidate };
}
