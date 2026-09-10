import type { SystemUpdateOperationDto, SystemUpdateOperationPhase } from "@chordv/shared";

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

// Ordered lifecycle stages of a running operation, matching the backend phase union.
// Which steps APPLY depends on the operation kind: a rollback/restart never downloads
// or extracts, and snapshot/migrate only run for an update that carries migrations
// (migrationApplied is only known after the fact, so those steps show for any update
// while running and collapse away on a skipped path — the phase union has no
// "skipped" report, so they simply never activate).
export const PHASE_STEPS: Array<{ phase: SystemUpdateOperationPhase; label: string }> = [
  { phase: "checking", label: "检查" },
  { phase: "downloading", label: "下载" },
  { phase: "extracting", label: "解压" },
  { phase: "draining", label: "切换" },
  { phase: "snapshotting", label: "快照" },
  { phase: "migrating", label: "迁移" },
  { phase: "health-gating", label: "健康检查" },
  { phase: "stabilizing", label: "稳定观察" }
];

// Steps that can ever run per operation kind. A step that cannot run is rendered as
// crossed-out/dimmed rather than completed, so a rollback does not claim a download
// it never performed.
export const APPLICABLE_STEPS: Record<SystemUpdateOperationDto["kind"], ReadonlySet<SystemUpdateOperationPhase>> = {
  update: new Set(PHASE_STEPS.map((step) => step.phase)),
  rollback: new Set(["checking", "draining", "health-gating", "stabilizing"]),
  restart: new Set(["draining", "health-gating", "stabilizing"])
};

// Supervisor-owned stages: whether they RUN is decided after the app exits (only an
// update carrying migrations snapshots/migrates), so they are only check-marked when
// actually OBSERVED by a poll — passing them silently is a skip, not a completion.
// App-side stages always run in order for the kinds that include them.
export const OBSERVED_ONLY_STEPS: ReadonlySet<SystemUpdateOperationPhase> = new Set(["snapshotting", "migrating"]);

export function phaseDescription(phase: SystemUpdateOperationPhase): string {
  switch (phase) {
    case "checking":
      return "正在确认最新版本与清单签名…";
    case "downloading":
      return "正在下载更新包…";
    case "extracting":
      return "正在校验并解压更新包…";
    case "draining":
      return "正在排空请求并切换版本，服务将短暂重启…";
    case "snapshotting":
      return "正在对数据库做迁移前快照…";
    case "migrating":
      return "正在执行数据库迁移…";
    case "health-gating":
      return "新版本已启动，正在通过健康检查…";
    case "stabilizing":
      return "新版本运行正常，正在稳定观察…";
    case "rollback-health-gating":
      return "新版本未通过验证，回滚目标已启动，正在通过健康检查…";
    case "rollback-stabilizing":
      return "回滚目标运行正常，正在稳定观察，随后将恢复服务…";
    default:
      return phase;
  }
}

