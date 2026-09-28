import type { ClientSupportLaunchDto, ClientSupportStatusDto } from "@chordv/shared";

/**
 * 新工单系统（Achord Connect）的打开流程与未读数处理。
 *
 * - 点击“工单”时，工单窗口已打开就只聚焦，不重复签发票据；
 * - 否则立即向后台申请一次性打开地址（60 秒内有效、只能用一次）并交给原生层打开；
 * - 打开地址的片段里带着票据，这里不记录、不拼进任何提示。
 *
 * 本文件保持无运行时依赖，便于回归测试直接加载。
 */

export const SUPPORT_DISABLED_MESSAGE = "工单系统暂未开放，请稍后再试";
export const MAX_SUPPORT_UNREAD_COUNT = 99_999;

/** 服务端推送、状态查询、原生桥接给出的未读数统一在这里校验；无效值返回 null（保持现有角标）。 */
export function normalizeSupportUnreadCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return Math.min(value, MAX_SUPPORT_UNREAD_COUNT);
}

/** 角标文字：0 不显示，超过 99 显示 99+。 */
export function formatSupportUnreadBadge(count: number) {
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  return count > 99 ? "99+" : String(Math.floor(count));
}

type ErrorLike = { status?: unknown; message?: unknown; rawMessage?: unknown };

/** 后台未启用新工单系统时，打开接口返回 503 和固定中文提示。 */
export function isSupportDisabledError(reason: unknown) {
  if (!reason || typeof reason !== "object") {
    return false;
  }
  const error = reason as ErrorLike;
  if (error.status !== 503) {
    return false;
  }
  const text = [error.message, error.rawMessage].filter((value) => typeof value === "string").join("\n");
  return text.includes("暂未开放");
}

export type SupportPortalOpenResult = "focused" | "opened" | "disabled" | "failed" | "busy";

export type SupportPortalDeps = {
  /** 最近一次状态查询得到的 enabled；还没查到时为 null。 */
  getKnownEnabled: () => boolean | null;
  /** 重新查询状态（用于 enabled=false 时确认后台是否刚刚开启）。 */
  refreshStatus: () => Promise<ClientSupportStatusDto | null>;
  launch: () => Promise<ClientSupportLaunchDto>;
  focusExisting: () => Promise<boolean>;
  openWindow: (launch: { launchUrl: string; supportOrigin: string }) => Promise<void>;
  notifyDisabled: () => void;
  showError: (reason: unknown) => void;
};

/** 同一时间只处理一次点击：连续点击不会签发多张票据。 */
export function createSupportPortalOpener(deps: SupportPortalDeps) {
  let inFlight: Promise<SupportPortalOpenResult> | null = null;

  const run = async (): Promise<SupportPortalOpenResult> => {
    try {
      if (await deps.focusExisting()) {
        return "focused";
      }
    } catch {
      // 聚焦失败时按未打开处理，重新打开一个窗口。
    }

    if (deps.getKnownEnabled() === false) {
      const status = await deps.refreshStatus().catch(() => null);
      if (!status?.enabled) {
        deps.notifyDisabled();
        return "disabled";
      }
    }

    try {
      const launch = await deps.launch();
      await deps.openWindow({ launchUrl: launch.launchUrl, supportOrigin: launch.supportOrigin });
      return "opened";
    } catch (reason) {
      if (isSupportDisabledError(reason)) {
        deps.notifyDisabled();
        return "disabled";
      }
      deps.showError(reason);
      return "failed";
    }
  };

  return {
    isBusy: () => inFlight !== null,
    open(): Promise<SupportPortalOpenResult> {
      if (inFlight) {
        return inFlight.then(() => "busy" as const);
      }
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}
