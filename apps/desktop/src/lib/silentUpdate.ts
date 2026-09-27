import type { ClientUpdateCheckResult, ReleaseChannel } from "../api/client";
import { compareVersion, type ResolvedUpdatePlatform, type UpdateDownloadState } from "./updateState";

/** 「自动在后台下载更新」偏好，默认开启；只有用户关掉时才写入 off。 */
export const AUTO_DOWNLOAD_UPDATE_KEY = "chordv_update_auto_download";

/** 后台静默下载失败只写诊断日志，不弹提示。 */
export const SILENT_UPDATE_LOG_CATEGORY = "update-auto-download";

/** 强制更新下载完成后，自动安装前的提示倒计时（秒）。 */
export const FORCED_INSTALL_COUNTDOWN_SECONDS = 10;

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

type AutoUpdateInput = {
  update: ClientUpdateCheckResult | null;
  channel: ReleaseChannel;
  appVersion: string;
  actionable: boolean;
  platform: ResolvedUpdatePlatform;
};

/** 两种自动流程的共同前提：当前通道确认过的可操作更新，且能由原生安装器在桌面端完成。 */
function isAutoManageableUpdate(input: AutoUpdateInput): input is AutoUpdateInput & { update: ClientUpdateCheckResult } {
  const update = input.update;
  if (!update || !input.actionable) return false;
  // 关掉测试版后残留的 beta 结果不算
  if (update.channel !== input.channel) return false;
  // 外链、APK 都需要用户自己操作
  if (input.platform !== "macos" && input.platform !== "windows") return false;
  return update.deliveryMode === "desktop_installer_download" && Boolean(update.downloadUrl);
}

function isForcedUpdate(update: ClientUpdateCheckResult, appVersion: string) {
  return update.forceUpgrade || compareVersion(update.minimumVersion, appVersion) > 0;
}

/**
 * 能否在后台静默下载：只针对用户本来就会收到的普通更新
 * （hasActionableUpdate 为真，含同版本更高构建；强制更新走自己的流程）。
 */
export function isSilentUpdateCandidate(input: AutoUpdateInput) {
  return isAutoManageableUpdate(input) && !isForcedUpdate(input.update, input.appVersion);
}

/**
 * 后台推送的强制更新（forceUpgrade / 低于最低版本）：自动下载，下载校验后倒计时自动安装。
 * 测试版永远不强制，客户端这里也再拦一次。
 */
export function isForcedAutoUpdateCandidate(input: AutoUpdateInput) {
  return (
    isAutoManageableUpdate(input) &&
    isForcedUpdate(input.update, input.appVersion) &&
    input.update.releaseChannel !== "beta"
  );
}

/**
 * 同一个更新包在本次运行里只自动下载一次；已在下载、已下载完成或失败过都不再触发。
 * attemptedIdentities 记录本次运行尝试过的所有更新包（来回切换通道也不会重下）。
 */
export function shouldStartAutoUpdateDownload(input: {
  enabled: boolean;
  allowed: boolean;
  candidate: boolean;
  phase: UpdateDownloadState["phase"];
  artifactIdentity: string | null;
  attemptedIdentities: ReadonlySet<string>;
}) {
  return (
    input.enabled &&
    input.allowed &&
    input.candidate &&
    input.phase === "idle" &&
    input.artifactIdentity !== null &&
    !input.attemptedIdentities.has(input.artifactIdentity)
  );
}

type ReadyInput = {
  download: Pick<UpdateDownloadState, "phase" | "localPath">;
  /** 最近一次下载完成时对应的更新包身份 */
  readyIdentity: string | null;
  artifactIdentity: string | null;
  /** 当前结果所属通道与用户选择的通道 */
  resultChannel: ReleaseChannel | null;
  channel: ReleaseChannel;
};

/** 当前更新包已下载并校验完成，且仍属于用户选择的通道。 */
function isDownloadedPackageCurrent(input: ReadyInput) {
  return (
    input.download.phase === "completed" &&
    Boolean(input.download.localPath) &&
    input.artifactIdentity !== null &&
    input.readyIdentity === input.artifactIdentity &&
    input.resultChannel === input.channel
  );
}

/** 普通更新已就绪：“检查更新”按钮变为“重启更新”，更新中心提示可立即安装。 */
export function isUpdateReadyIndicatorVisible(input: ReadyInput & { forceUpdateRequired: boolean }) {
  return isDownloadedPackageCurrent(input) && !input.forceUpdateRequired;
}

/** 强制更新下载完成：开始不可取消的倒计时，结束后自动安装。每个更新包只自动安装一次。 */
export function shouldStartForcedInstallCountdown(input: ReadyInput & {
  forcedCandidate: boolean;
  allowed: boolean;
  attemptedIdentities: ReadonlySet<string>;
}) {
  return (
    input.forcedCandidate &&
    input.allowed &&
    isDownloadedPackageCurrent(input) &&
    !input.attemptedIdentities.has(input.artifactIdentity as string)
  );
}

/**
 * 倒计时的一步：更新包失效就取消；提示不可见时暂停；到 0 触发安装。
 */
export function stepForcedInstallCountdown(input: { countdown: number | null; valid: boolean; visible: boolean }):
  | { type: "idle" }
  | { type: "cancel" }
  | { type: "pause" }
  | { type: "install" }
  | { type: "tick"; next: number } {
  if (input.countdown === null) return { type: "idle" };
  if (!input.valid) return { type: "cancel" };
  if (!input.visible) return { type: "pause" };
  if (input.countdown <= 0) return { type: "install" };
  return { type: "tick", next: input.countdown - 1 };
}

export function formatSilentUpdateFailureLog(input: {
  version: string | null | undefined;
  code: string | null | undefined;
  detail: string | null | undefined;
}) {
  return `background download failed version=${input.version ?? "-"} code=${input.code ?? "-"} detail=${input.detail || "-"}`;
}
