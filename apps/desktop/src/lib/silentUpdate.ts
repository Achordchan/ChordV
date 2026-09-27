import type { ClientUpdateCheckResult, ReleaseChannel } from "../api/client";
import { compareVersion, type ResolvedUpdatePlatform, type UpdateDownloadState } from "./updateState";

/** 「自动在后台下载更新」偏好，默认开启；只有用户关掉时才写入 off。 */
export const AUTO_DOWNLOAD_UPDATE_KEY = "chordv_update_auto_download";

/** 后台静默下载失败只写诊断日志，不弹提示。 */
export const SILENT_UPDATE_LOG_CATEGORY = "update-auto-download";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readAutoDownloadPreference(storage: PreferenceStorage | null | undefined) {
  try {
    return storage?.getItem(AUTO_DOWNLOAD_UPDATE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAutoDownloadPreference(storage: PreferenceStorage | null | undefined, enabled: boolean) {
  try {
    storage?.setItem(AUTO_DOWNLOAD_UPDATE_KEY, enabled ? "on" : "off");
  } catch {
    // 保留内存里的选择即可
  }
}

/**
 * 能否在后台静默下载：只针对用户本来就会收到的普通更新。
 * - 必须是当前通道确认过的结果（关掉测试版后残留的 beta 结果不算）；
 * - 必须是可操作的更新（hasActionableUpdate，含同版本更高构建）；
 * - 强制更新 / 低于最低版本走原有的阻断流程，不在这里处理；
 * - 只有桌面端原生安装器下载才能静默进行，外链、APK 都需要用户自己操作。
 */
export function isSilentUpdateCandidate(input: {
  update: ClientUpdateCheckResult | null;
  channel: ReleaseChannel;
  appVersion: string;
  actionable: boolean;
  platform: ResolvedUpdatePlatform;
}) {
  const update = input.update;
  if (!update || !input.actionable) return false;
  if (update.channel !== input.channel) return false;
  if (input.platform !== "macos" && input.platform !== "windows") return false;
  if (update.forceUpgrade || compareVersion(update.minimumVersion, input.appVersion) > 0) return false;
  return update.deliveryMode === "desktop_installer_download" && Boolean(update.downloadUrl);
}

/** 同一个更新包在本次运行里只自动尝试一次；已在下载、已下载完成或失败过都不再触发。 */
export function shouldStartSilentUpdateDownload(input: {
  enabled: boolean;
  allowed: boolean;
  candidate: boolean;
  phase: UpdateDownloadState["phase"];
  artifactIdentity: string | null;
  attemptedIdentity: string | null;
}) {
  return (
    input.enabled &&
    input.allowed &&
    input.candidate &&
    input.phase === "idle" &&
    Boolean(input.artifactIdentity) &&
    input.attemptedIdentity !== input.artifactIdentity
  );
}

/** 「新版本已就绪 · 重启更新」标记：只给后台下载完成、且仍对应当前更新包的普通更新显示。 */
export function isUpdateReadyIndicatorVisible(input: {
  download: Pick<UpdateDownloadState, "phase" | "localPath">;
  readyIdentity: string | null;
  artifactIdentity: string | null;
  forceUpdateRequired: boolean;
}) {
  return (
    input.download.phase === "completed" &&
    Boolean(input.download.localPath) &&
    Boolean(input.artifactIdentity) &&
    input.readyIdentity === input.artifactIdentity &&
    !input.forceUpdateRequired
  );
}

export function formatSilentUpdateFailureLog(input: {
  version: string | null | undefined;
  code: string | null | undefined;
  detail: string | null | undefined;
}) {
  return `background download failed version=${input.version ?? "-"} code=${input.code ?? "-"} detail=${input.detail || "-"}`;
}
