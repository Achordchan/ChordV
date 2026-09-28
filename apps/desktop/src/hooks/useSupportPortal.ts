import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSessionDto } from "@chordv/shared";
import { fetchSupportStatus, isUnauthorizedApiError, launchSupportPortal } from "../api/client";
import { closeSupportWindow, createSupportWindowTarget, subscribeSupportUnread } from "../lib/runtime";
import {
  createSupportPortalOpener,
  normalizeSupportUnreadCount,
  SUPPORT_DISABLED_MESSAGE,
  SupportPortalStaleError
} from "../lib/supportPortal";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

type UseSupportPortalOptions = {
  accessToken: string | null;
  /** 账号变化（退出登录、换账号）时关闭工单窗口。 */
  userId: string | null;
  onUnauthorized?: () => Promise<AuthSessionDto | null> | AuthSessionDto | null;
  notify: (notice: NoticeInput) => void;
  showError: (reason: unknown) => void;
};

/**
 * 新工单系统（Achord Connect）：“工单”按钮的未读角标和打开独立工单窗口。
 * 未读数来源：登录 / 推送重连后的状态查询、support_unread_updated 推送、工单窗口的原生桥接。
 */
export function useSupportPortal(options: UseSupportPortalOptions) {
  const [supportUnreadCount, setSupportUnreadCount] = useState(0);
  const [supportOpening, setSupportOpening] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const accessTokenRef = useRef(options.accessToken);
  accessTokenRef.current = options.accessToken;
  const enabledRef = useRef<boolean | null>(null);
  // 账号代次：退出登录或换账号时递增，进行中的打开流程据此作废。
  const accountGenerationRef = useRef(0);
  const previousUserIdRef = useRef(options.userId);
  if (previousUserIdRef.current !== options.userId) {
    previousUserIdRef.current = options.userId;
    accountGenerationRef.current += 1;
  }
  // 未读数版本：推送 / 桥接和每次状态查询都会递增，晚到的查询结果不能覆盖更新的未读数。
  const unreadRevisionRef = useRef(0);

  const applySupportUnreadCount = useCallback((value: unknown) => {
    const next = normalizeSupportUnreadCount(value);
    if (next !== null && accessTokenRef.current) {
      unreadRevisionRef.current += 1;
      setSupportUnreadCount(next);
    }
  }, []);

  const refreshSupportStatus = useCallback(async (accessTokenOverride?: string) => {
    const accessToken = accessTokenOverride ?? accessTokenRef.current;
    if (!accessToken) {
      return null;
    }
    const revision = ++unreadRevisionRef.current;
    try {
      const status = await fetchSupportStatus(accessToken);
      if (accessTokenRef.current !== accessToken) {
        return null;
      }
      enabledRef.current = status.enabled === true;
      const next = normalizeSupportUnreadCount(status.enabled ? status.unreadCount : 0);
      if (unreadRevisionRef.current === revision && next !== null) {
        setSupportUnreadCount(next);
      }
      return status;
    } catch (reason) {
      // 状态查询失败只保留现有角标；登录失效交给统一的恢复流程。
      if (isUnauthorizedApiError(reason) && accessTokenRef.current === accessToken) {
        await latest.current.onUnauthorized?.();
      }
      return null;
    }
  }, [applySupportUnreadCount]);

  const openerRef = useRef<ReturnType<typeof createSupportPortalOpener> | null>(null);
  if (!openerRef.current) {
    openerRef.current = createSupportPortalOpener({
      prepareTarget: createSupportWindowTarget,
      getAccountGeneration: () => accountGenerationRef.current,
      getKnownEnabled: () => enabledRef.current,
      refreshStatus: () => refreshSupportStatus(),
      launch: async (isCurrent) => {
        const accessToken = accessTokenRef.current;
        if (!accessToken) {
          throw new SupportPortalStaleError();
        }
        try {
          return await launchSupportPortal(accessToken);
        } catch (reason) {
          if (!isUnauthorizedApiError(reason) || !isCurrent()) {
            throw reason;
          }
          // 访问令牌刚好过期：恢复登录后用新令牌重试一次，票据仍是现签现用；恢复期间账号变化则放弃。
          const recovered = await latest.current.onUnauthorized?.();
          if (!isCurrent()) {
            throw new SupportPortalStaleError();
          }
          if (!recovered?.accessToken) {
            throw reason;
          }
          return await launchSupportPortal(recovered.accessToken);
        }
      },
      notifyDisabled: () =>
        latest.current.notify({ color: "blue", title: "工单暂未开放", message: SUPPORT_DISABLED_MESSAGE }),
      showError: (reason) => latest.current.showError(reason)
    });
  }

  const openSupportPortal = useCallback(async () => {
    setSupportOpening(true);
    try {
      return await openerRef.current!.open();
    } finally {
      setSupportOpening(false);
    }
  }, []);

  // 退出登录或换账号：清掉上一个账号的未读数和开放状态、作废它还没返回的查询，
  // 关闭工单窗口并作废原生层进行中的打开（避免下一个账号看到上一个账号的工单）。
  // 必须排在下面的状态查询之前，否则新账号刚发起的查询也会被作废。
  const closedForUserIdRef = useRef(options.userId);
  useEffect(() => {
    const previous = closedForUserIdRef.current;
    closedForUserIdRef.current = options.userId;
    if (previous === options.userId) {
      return;
    }
    enabledRef.current = null;
    unreadRevisionRef.current += 1;
    setSupportUnreadCount(0);
    if (previous) {
      void closeSupportWindow().catch(() => undefined);
    }
  }, [options.userId]);

  useEffect(() => {
    if (!options.accessToken) {
      enabledRef.current = null;
      setSupportUnreadCount(0);
      return;
    }
    void refreshSupportStatus(options.accessToken);
  }, [options.accessToken, refreshSupportStatus]);


  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void subscribeSupportUnread(applySupportUnreadCount)
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unsubscribe = dispose;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [applySupportUnreadCount]);

  return {
    supportUnreadCount,
    supportOpening,
    openSupportPortal,
    refreshSupportStatus,
    applySupportUnreadCount
  };
}
