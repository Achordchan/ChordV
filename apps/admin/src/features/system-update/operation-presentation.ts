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
