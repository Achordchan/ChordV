import type { SystemUpdateOperationDto } from "@chordv/shared";
import type { UpdateConnection } from "./operation-observer";

export function statusColor(status: SystemUpdateOperationDto["status"]): string {
  switch (status) {
    case "succeeded":
      return "teal";
    case "failed":
      return "red";
    case "rolled_back":
      return "orange";
    default:
      return "blue";
  }
}

export function statusLabel(status: SystemUpdateOperationDto["status"]): string {
  switch (status) {
    case "pending":
      return "等待中";
    case "running":
      return "进行中";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "rolled_back":
      return "已回滚";
    default:
      return status;
  }
}

export function kindLabel(kind: SystemUpdateOperationDto["kind"]): string {
  return kind === "update" ? "更新" : kind === "rollback" ? "回滚" : "重启";
}

// The app cannot stream supervisor progress while it is stopped or awaiting
// approval. Keep those internal phases in the server audit, but present one
// recovery stage rather than a sequence the browser cannot observe live.
const STEPS = [
  { id: "downloading", label: "下载更新包" },
  { id: "extracting", label: "解压更新包" },
  { id: "switching", label: "服务切换与恢复" },
  { id: "result", label: "确认结果" }
] as const;
const SWITCH_PHASES = new Set(["draining", "snapshotting", "migrating", "health-gating", "stabilizing", "rollback-health-gating", "rollback-stabilizing"]);

export function operationProgress(operation: SystemUpdateOperationDto | null, kind: SystemUpdateOperationDto["kind"], connection: UpdateConnection) {
  const phase = operation?.phase;
  const switching = Boolean(phase && SWITCH_PHASES.has(phase));
  const stage = switching ? "switching" : phase;
  const steps = kind === "update" ? STEPS : STEPS.filter(step => step.id === "switching" || step.id === "result");
  const index = steps.findIndex(step => step.id === stage);
  const live = connection === "live";
  const paused = connection === "paused";
  const recovering = !live;
  const title = paused ? "状态观察已暂停"
    : switching ? "服务切换中，等待恢复"
    : recovering ? "等待后台恢复连接"
    : phase === "downloading" ? "正在下载更新包"
    : phase === "extracting" ? "正在解压更新包"
    : "正在准备" + kindLabel(kind);
  const description = paused ? "仅暂停状态查询，后台任务不会因此停止。"
    : switching ? "切换期间无法实时显示内部步骤，结果确认后将自动刷新。"
    : recovering ? "当前进度暂不可确认，等待恢复连接后读取实际结果。"
    : "服务切换后会短暂断开，结果确认后将自动刷新。";
  const lastConfirmed = recovering && phase
    ? (steps.find(step => step.id === stage)?.label ?? (phase === "checking" ? "检查更新" : null)) : null;
  return {
    title, description, lastConfirmed, recovering,
    showDownloadProgress: live && phase === "downloading",
    steps: steps.map((step, position) => ({ ...step,
      state: position < index ? "completed" as const
        : position !== index ? "waiting" as const
        : recovering ? "unconfirmed" as const : "active" as const
    }))
  };
}

/** A normal update restart: drain ~1s, supervisor promotion and readiness
 * ~15s, then STABILIZE_SECONDS (10s) before the new process is approved, plus
 * one admin webroot poll (3s). 30s covers that with margin, so the countdown
 * rarely runs out before the confirmed reload happens. */
export const RESTART_COUNTDOWN_SECONDS = 30;
/** Past the supervisor's 90s health gate plus its rollback: something needs a
 * human look. Checking continues; the view only stops sounding reassuring. */
export const RESTART_OVERDUE_SECONDS = 180;
/** Fixed retry cadence while a restart is expected (replaces 3s→30s backoff). */
export const RESTART_RETRY_MS = 2000;
export const RESTART_OVERDUE_RETRY_MS = 5000;

export type RestartWait = { operationId: string; kind: SystemUpdateOperationDto["kind"]; toVersion: string | null; since: number };

// Phases in which this process is (about to be) gone: the app marks "draining"
// right before it exits, and every later phase is supervisor-owned.
const RESTART_PHASES = new Set(["draining", ...SWITCH_PHASES]);
const isRunning = (operation: SystemUpdateOperationDto) => operation.status === "running" || operation.status === "pending";

/** A live snapshot that already says the process is going down. Rollback and
 * restart have no app-side stage besides a momentary "checking". */
export function restartImminent(operation: SystemUpdateOperationDto) {
  return isRunning(operation) && (operation.kind !== "update" || Boolean(operation.phase && RESTART_PHASES.has(operation.phase)));
}

/** Whether losing the connection now is the expected restart. After extraction
 * the app only detects migrations and marks "draining" before draining closes
 * every stream, and the drain usually wins the race against that last event —
 * so the last delivered phase of a healthy update is "extracting". Extraction
 * failures are reported over the still-open stream rather than by a drop.
 * A drop while checking or downloading stays "unconfirmed". */
export function restartExpected(operation: SystemUpdateOperationDto) {
  return restartImminent(operation) || (isRunning(operation) && operation.kind === "update" && operation.phase === "extracting");
}

/** Next restart-wait state for the latest operation snapshot and connection. */
export function trackRestart(current: RestartWait | null, operation: SystemUpdateOperationDto | null,
  connection: UpdateConnection, now: number): RestartWait | null {
  if (!operation) return current;
  if (current && current.operationId !== operation.operationId) current = null;
  if (!isRunning(operation)) return null;
  const live = connection === "live";
  const expected = live ? restartImminent(operation) : connection === "reconnecting" && restartExpected(operation);
  if (expected) return current ?? { operationId: operation.operationId, kind: operation.kind, toVersion: operation.toVersion ?? null, since: now };
  // A live snapshot from an earlier stage proves the process never restarted
  // (e.g. a network blip during extraction): back to regular progress.
  return live ? null : current;
}

export function restartView(wait: RestartWait, now: number) {
  const elapsed = Math.max(0, Math.floor((now - wait.since) / 1000));
  const countdown = Math.max(0, RESTART_COUNTDOWN_SECONDS - elapsed);
  const overdue = elapsed >= RESTART_OVERDUE_SECONDS;
  const title = overdue ? "服务长时间未恢复"
    : wait.kind === "update" ? "更新已安装，服务正在重启"
    : wait.kind === "rollback" ? "回滚已就绪，服务正在重启" : "服务正在重启";
  // A same-version restart keeps the page; update/rollback reload onto the new build.
  const reloads = wait.kind !== "restart";
  const description = overdue
    ? `已等待约 ${Math.floor(elapsed / 60)} 分钟，仍在自动检测。包含数据库迁移时可能需要更久；如持续无响应，请检查服务器状态后刷新页面。`
    : countdown > 0 ? (reloads ? `${countdown} 秒后自动刷新页面` : `预计 ${countdown} 秒内恢复`)
    : reloads ? "即将完成，正在确认服务状态，恢复后自动刷新页面。" : "即将完成，正在确认服务状态。";
  return { title, description, countdown, overdue, percent: Math.min(100, Math.round(elapsed / RESTART_COUNTDOWN_SECONDS * 100)) };
}
