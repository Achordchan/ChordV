import type { UpdateDownloadState } from "../lib/updateState";
import { downloadProgressPercent, formatByteSize, hasKnownTotalBytes } from "../lib/updateState";
import { describeUserError } from "../lib/userFacingErrors";
import { DownloadProgressPanel } from "./DownloadProgressPanel";

export function ClientUpdateProgressPanel({state,version,onRetry,onInstall,onResetLegacyMirror}: {
  onResetLegacyMirror?: (()=>void)|null;
  state: UpdateDownloadState; version?: string; onRetry: ()=>void; onInstall: ()=>void;
}) {
  if (state.phase === "idle") return null;
  const completed = state.phase === "completed";
  const failed = state.phase === "failed";
  const verifying = state.phase === "verifying";
  // 失败说明统一经过客户文案映射，错误编号作为次要信息展示。
  const failure = failed ? describeUserError(state.message ?? "", { context: "update_download" }) : null;
  const percent = completed ? 100 : hasKnownTotalBytes(state.totalBytes) ? downloadProgressPercent(state) : null;
  const amount = completed ? "更新包已就绪" : failed ? "请重试或查看详情" : verifying ? "文件已下载，正在校验" :
    hasKnownTotalBytes(state.totalBytes) ? `${formatByteSize(state.downloadedBytes)} / ${formatByteSize(state.totalBytes)}` :
      state.downloadedBytes > 0 ? `已下载 ${formatByteSize(state.downloadedBytes)}` : "正在连接下载服务器";
  return <DownloadProgressPanel label="客户端更新下载进度" onResetLegacyMirror={onResetLegacyMirror} title={completed ? "客户端更新包已就绪" : failed ? "客户端更新下载失败" : verifying ? "正在校验客户端更新包" : `正在下载 ChordV${version ? ` ${version}` : " 更新包"}`}
    amount={amount} percent={percent} failed={failed} completed={completed} waiting={state.phase==="preparing"||verifying||(!failed&&!completed&&percent===null)}
    errorCode={failure ? state.errorCode ?? failure.code : null}
    details={[state.fileName,failure ? failure.message : state.message].filter((line):line is string=>Boolean(line))}
    action={failed ? {label:"重新下载",onClick:onRetry} : completed ? {label:"安装并重启",onClick:onInstall} : null}/>
}
