import type { RuntimeAssetsUiState } from "../lib/runtimeComponents";
import { downloadProgressPresentation } from "../lib/downloadProgressPresentation";
import { describeRuntimeAssetsFailure, formatErrorCodeLine } from "../lib/userFacingErrors";
import { DownloadProgressPanel } from "./DownloadProgressPanel";

type Props = { onResetLegacyMirror?: (()=>void)|null; state: RuntimeAssetsUiState; onRetry?: (()=>void)|null; onCancel?: (()=>void)|null };
export function RuntimeAssetsBanner({state,onRetry,onCancel,onResetLegacyMirror}: Props) {
  if (state.phase === "idle" || state.phase === "ready") return null;
  const view = downloadProgressPresentation(state);
  const failed = state.phase === "failed";
  // 失败时只展示客户可读的说明；原始错误已在失败时上报并写入诊断日志。
  const failureText = failed ? describeRuntimeAssetsFailure(state.errorCode, state.errorMessage || state.message).message : null;
  return <DownloadProgressPanel label="组件下载进度" {...view} onResetLegacyMirror={onResetLegacyMirror}
    failed={failed && !view.cancelled} completed={state.phase === "completed"}
    waiting={state.phase === "checking" || view.processing || (state.phase === "downloading" && view.percent === null)}
    onCancel={state.phase === "checking" || state.phase === "downloading" ? onCancel : null}
    action={failed && onRetry ? {label:"重新下载",onClick:onRetry} : null}
    details={[state.fileName,failureText ?? (state.errorMessage||state.message),!view.cancelled?formatErrorCodeLine(state.errorCode):null,state.blocking&&state.phase!=="completed"?"组件准备完成后可连接。":null].filter((line):line is string=>Boolean(line))}/>
}
