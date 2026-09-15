import type { RuntimeAssetsUiState } from "./runtimeComponents";

export function downloadProgressPresentation(state: RuntimeAssetsUiState) {
  const name = state.currentComponent === "xray" ? "Xray 内核" : state.currentComponent === "geoip" ? "GeoIP 规则" : state.currentComponent === "geosite" ? "GeoSite 规则" : "组件";
  const cancelled = state.phase === "failed" && state.errorCode === "download_cancelled";
  const processing = state.phase === "downloading" && (state.downloadStage === "verifying" || state.downloadStage === "extracting");
  const total = Number.isFinite(state.totalBytes) && state.totalBytes! > 0 ? state.totalBytes : null;
  const downloaded = Number.isFinite(state.downloadedBytes) ? Math.max(0, state.downloadedBytes) : 0;
  const percent = state.phase === "completed" ? 100 : state.phase === "downloading" && total
    ? Math.min(100, Math.max(0, downloaded / total * 100)) : null;
  const title = state.phase === "failed" ? cancelled ? "下载已取消" : `${name}下载未完成`
    : state.phase === "completed" ? `${name}已准备完成`
    : state.phase === "checking" ? "正在检查组件更新"
    : processing ? `正在${state.downloadStage === "verifying" ? "校验" : "整理"} ${name}` : `正在下载 ${name}`;
  const amount = state.phase === "failed" ? cancelled ? "可随时重新下载" : "请重试或查看详情"
    : state.phase === "completed" ? "组件已就绪"
    : processing ? state.message || "正在校验并保存"
    : state.phase === "checking" ? "正在获取版本信息"
    : total ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
    : downloaded > 0 ? `已下载 ${formatBytes(downloaded)}` : "正在接收数据";
  const percentLabel = percent === null ? null : percent >= 100 ? 100 : Math.min(99, Math.round(percent));
  return { title, amount, percent, percentLabel, processing, cancelled };
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}
