import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSessionDto } from "@chordv/shared";
import { fetchSupportStatus, isUnauthorizedApiError, launchSupportPortal } from "../api/client";
import { closeSupportWindow, createSupportWindowTarget, subscribeSupportWindowEvents } from "../lib/runtime";
import {
  createSupportPortalOpener,
  normalizeSupportUnreadCount,
  SUPPORT_DISABLED_MESSAGE,
  SUPPORT_UPGRADING_MESSAGE,
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
  // 当前账号打开的工单窗口所属的原生批次号；桥接未读事件只接受这个批次，换账号时清空。
  const bridgeEpochRef = useRef<number | null>(null);
  // 工单窗口打开且门户通过桥接报告过未读数：此时角标以桥接为准，后台推送和状态查询不覆盖；
  // 窗口关闭或门户报告会话过期后改回以后台为准，并立即重新查询一次。
  const bridgeActiveRef = useRef(false);

  const setUnreadCount = useCallback((value: unknown) => {
    const next = normalizeSupportUnreadCount(value);
    if (next !== null && accessTokenRef.current) {
      unreadRevisionRef.current += 1;
      setSupportUnreadCount(next);
    }
  }, []);

  /** 后台推送（support_unread_updated）的未读数；工单窗口正在报告未读时以窗口为准。 */
  const applySupportUnreadCount = useCallback((value: unknown) => {
    if (!bridgeActiveRef.current) {
      setUnreadCount(value);
    }
  }, [setUnreadCount]);

  const refreshSupportStatus = useCallback(async (accessTokenOverride?: string) => {
    const accessToken = accessTokenOverride ?? accessTokenRef.current;
    if (!accessToken) {
      return null;
    }
    const generation = accountGenerationRef.current;
    const revision = ++unreadRevisionRef.current;
    const isCurrent = () => accountGenerationRef.current === generation && Boolean(accessTokenRef.current);
    const load = async () => {
      try {
        return await fetchSupportStatus(accessToken);
      } catch (reason) {
        if (!isUnauthorizedApiError(reason) || !isCurrent()) {
          throw reason;
        }
        // 登录失效：交给统一的恢复流程，恢复成功后用新令牌重查一次。
        const recovered = await latest.current.onUnauthorized?.();
        if (!recovered?.accessToken || !isCurrent()) {
          throw reason;
        }
        return await fetchSupportStatus(recovered.accessToken);
      }
    };
    try {
      const status = await load();
      if (!isCurrent()) {
        return null;
      }
      enabledRef.current = status.enabled === true;
      const next = normalizeSupportUnreadCount(status.enabled ? status.unreadCount : 0);
      if (unreadRevisionRef.current === revision && !bridgeActiveRef.current && next !== null) {
        setSupportUnreadCount(next);
      }
      return status;
    } catch {
      // 状态查询失败只保留现有角标，返回 null 表示“不确定”，不是“未开放”。
      return null;
    }
  }, []);

  const openerRef = useRef<ReturnType<typeof createSupportPortalOpener> | null>(null);
  if (!openerRef.current) {
    openerRef.current = createSupportPortalOpener({
      prepareTarget: () => {
        const generation = accountGenerationRef.current;
        return createSupportWindowTarget({
          onEpoch: (epoch) => {
            if (accountGenerationRef.current === generation) bridgeEpochRef.current = epoch;
          }
        });
      },
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
      notifyUpgrading: () =>
        latest.current.notify({ color: "yellow", title: "工单系统升级中", message: SUPPORT_UPGRADING_MESSAGE }),
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
    bridgeEpochRef.current = null;
    bridgeActiveRef.current = false;
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
    // 只接受当前账号打开的工单窗口发出的事件：换账号前已排队的旧窗口消息会被丢弃。
    const isCurrentWindow = (epoch: number) => bridgeEpochRef.current !== null && epoch === bridgeEpochRef.current;
    void subscribeSupportWindowEvents({
      onUnread: (event) => {
        if (!isCurrentWindow(event.epoch) || !accessTokenRef.current) return;
        bridgeActiveRef.current = true;
        setUnreadCount(event.unreadCount);
      },
      onEnded: (event) => {
        if (!isCurrentWindow(event.epoch) || !bridgeActiveRef.current) return;
        bridgeActiveRef.current = false;
        void refreshSupportStatus();
      }
    })
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
  }, [refreshSupportStatus, setUnreadCount]);

  return {
    supportUnreadCount,
    supportOpening,
    openSupportPortal,
    refreshSupportStatus,
    applySupportUnreadCount
  };
}
