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

export type SupportPortalOpenResult = "focused" | "opened" | "disabled" | "failed" | "busy" | "stale";

/** 与 runtime.ts 的 SupportWindowTarget 一致；这里单独声明，保持本文件无运行时依赖。 */
export type SupportPortalTarget = {
  focusExisting: () => Promise<boolean>;
  open: (launch: { launchUrl: string; supportOrigin: string }) => Promise<void>;
  dispose: () => void;
};

export type SupportPortalDeps = {
  /** 必须同步返回：浏览器端要在点击事件里预留新窗口。 */
  prepareTarget: () => SupportPortalTarget;
  /** 当前账号标识（登录代次）；打开流程中途变化说明已退出登录或换了账号。 */
  getAccountGeneration: () => number;
  /** 最近一次状态查询得到的 enabled；还没查到时为 null。 */
  getKnownEnabled: () => boolean | null;
  /** 重新查询状态（用于 enabled=false 时确认后台是否刚刚开启）。 */
  refreshStatus: () => Promise<ClientSupportStatusDto | null>;
  /** isCurrent 在每次等待之后检查账号是否仍是发起时的账号。 */
  launch: (isCurrent: () => boolean) => Promise<ClientSupportLaunchDto>;
  notifyDisabled: () => void;
  showError: (reason: unknown) => void;
};

/** 账号在打开途中变化时抛出，调用方静默结束，不打开任何窗口、不提示错误。 */
export class SupportPortalStaleError extends Error {
  constructor() {
    super("账号已变化，工单未打开");
    this.name = "SupportPortalStaleError";
  }
}

/** 同一时间只处理一次点击：连续点击不会签发多张票据。 */
export function createSupportPortalOpener(deps: SupportPortalDeps) {
  let inFlight: Promise<SupportPortalOpenResult> | null = null;

  const run = async (target: SupportPortalTarget): Promise<SupportPortalOpenResult> => {
    const generation = deps.getAccountGeneration();
    const isCurrent = () => deps.getAccountGeneration() === generation;
    const ensureCurrent = () => {
      if (!isCurrent()) throw new SupportPortalStaleError();
    };
    try {
      if (await target.focusExisting()) {
        return "focused";
      }
      ensureCurrent();

      if (deps.getKnownEnabled() === false) {
        const status = await deps.refreshStatus().catch(() => null);
        ensureCurrent();
        if (!status?.enabled) {
          deps.notifyDisabled();
          return "disabled";
        }
      }

      const launch = await deps.launch(isCurrent);
      ensureCurrent();
      await target.open({ launchUrl: launch.launchUrl, supportOrigin: launch.supportOrigin });
      return "opened";
    } catch (reason) {
      if (reason instanceof SupportPortalStaleError || !isCurrent()) {
        return "stale";
      }
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
      const target = deps.prepareTarget();
      inFlight = run(target)
        .then((result) => {
          if (result !== "opened") target.dispose();
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }
  };
}
