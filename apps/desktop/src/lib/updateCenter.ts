import type { ClientUpdateCheckResult } from "../api/client";

export type UpdateCenterItemKey = "app" | "xray" | "geo";

export type UpdateCenterItemStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "updating"
  | "failed"
  | "unsupported";

export type UpdateCenterItem = {
  key: UpdateCenterItemKey;
  label: string;
  enabled: boolean;
  status: UpdateCenterItemStatus;
  localVersion: string | null;
  remoteVersion: string | null;
  message: string;
  canUpdate: boolean;
};

export type UpdateCenterState = {
  opened: boolean;
  checking: boolean;
  updatingKey: UpdateCenterItemKey | "all" | null;
  items: UpdateCenterItem[];
  lastCheckedAt: number | null;
};

export function createDefaultUpdateCenterItems(): UpdateCenterItem[] {
  return [
    {
      key: "app",
      label: "软件",
      enabled: true,
      status: "idle",
      localVersion: null,
      remoteVersion: null,
      message: "尚未检查",
      canUpdate: false
    },
    {
      key: "xray",
      label: "Xray",
      enabled: true,
      status: "idle",
      localVersion: null,
      remoteVersion: null,
      message: "尚未检查",
      canUpdate: false
    },
    {
      key: "geo",
      label: "GEO 数据",
      enabled: true,
      status: "idle",
      localVersion: null,
      remoteVersion: null,
      message: "尚未检查",
      canUpdate: false
    }
  ];
}

export function createIdleUpdateCenterState(): UpdateCenterState {
  return {
    opened: false,
    checking: false,
    updatingKey: null,
    items: createDefaultUpdateCenterItems(),
    lastCheckedAt: null
  };
}

export function formatUpdateCenterItemMessage(item: UpdateCenterItem) {
  if (item.status === "checking") {
    return "正在检查…";
  }
  if (item.status === "updating") {
    return "正在更新…";
  }
  if (item.status === "failed") {
    return item.message || "检查失败";
  }
  if (item.status === "available") {
    // 优先展示业务侧给出的准确说明（例如“本地文件与远端不一致”）
    if (item.message) {
      return item.message;
    }
    if (item.remoteVersion) {
      return `有新版本可用：${item.remoteVersion}`;
    }
    return "有新版本可用";
  }
  if (item.status === "current") {
    if (item.localVersion) {
      return `${item.label} ${item.localVersion} 已是最新版本。`;
    }
    return item.message || "已是最新版本";
  }
  return item.message || "尚未检查";
}

export function buildAppUpdateCenterItem(input: {
  appVersion: string;
  update: ClientUpdateCheckResult | null;
  hasActionableUpdate: boolean;
}): UpdateCenterItem {
  const remote = input.update?.latestVersion ?? input.appVersion;
  if (!input.update) {
    return {
      key: "app",
      label: "软件",
      enabled: true,
      status: "failed",
      localVersion: input.appVersion,
      remoteVersion: null,
      message: "软件版本检查失败",
      canUpdate: false
    };
  }
  if (input.hasActionableUpdate) {
    return {
      key: "app",
      label: "软件",
      enabled: true,
      status: "available",
      localVersion: input.appVersion,
      remoteVersion: remote,
      message: `有新版本可用：${remote}`,
      canUpdate: Boolean(input.update.downloadUrl)
    };
  }
  return {
    key: "app",
    label: "软件",
    enabled: true,
    status: "current",
    localVersion: input.appVersion,
    remoteVersion: remote,
    message: `软件 ${input.appVersion} 已是最新版本。`,
    canUpdate: false
  };
}

export function shortVersionLabel(value: string | null | undefined, fallback = "未知") {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  if (text.length <= 18) {
    return text;
  }
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}
