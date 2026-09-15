import type { RuntimeAssetsUiState } from "../lib/runtimeComponents";
import { downloadProgressPresentation } from "../lib/downloadProgressPresentation";
import { DownloadProgressPanel } from "./DownloadProgressPanel";

type Props = { state: RuntimeAssetsUiState; onRetry?: (()=>void)|null; onCancel?: (()=>void)|null };
export function RuntimeAssetsBanner({state,onRetry,onCancel}: Props) {
  if (state.phase === "idle" || state.phase === "ready") return null;
  const view = downloadProgressPresentation(state);
  return <DownloadProgressPanel label="组件下载进度" {...view}
    failed={state.phase === "failed" && !view.cancelled} completed={state.phase === "completed"}
    waiting={state.phase === "checking" || view.processing || (state.phase === "downloading" && view.percent === null)}
    onCancel={state.phase === "checking" || state.phase === "downloading" ? onCancel : null}
    action={state.phase === "failed" && onRetry ? {label:"重新下载",onClick:onRetry} : null}
    details={[state.fileName,state.errorMessage||state.message,state.errorCode&&!view.cancelled?`错误代码：${state.errorCode}`:null,state.blocking&&state.phase!=="completed"?"组件准备完成后可连接。":null].filter((line):line is string=>Boolean(line))}/>
}
