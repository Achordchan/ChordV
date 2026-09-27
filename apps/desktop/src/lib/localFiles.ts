/**
 * “本地文件”弹窗的数据整理：路径一律来自原生端的实际解析结果，这里只负责
 * 固定条目的中文名称、状态文案和版本拼接。登录凭据（session.json）永远不会出现在列表里。
 */

export type LocalFileKind = "appData" | "xray" | "geoip" | "geosite" | "runtime" | "updater";

/** 原生端 list_local_file_locations 返回的一项。 */
export type LocalFileEntry = {
  kind: LocalFileKind;
  path: string;
  isDirectory: boolean;
  exists: boolean;
  sizeBytes: number | null;
};

export type LocalFileVersions = {
  xray?: string | null;
  geo?: string | null;
};

export type LocalFileRow = {
  kind: LocalFileKind;
  label: string;
  hint: string | null;
  path: string;
  isDirectory: boolean;
  exists: boolean;
  /** 行内状态：大小与版本，或“尚未下载”。 */
  status: string | null;
  /** “在文件夹中显示”按钮的说明；文件不存在时打开上级目录。 */
  revealLabel: string;
};

export const LOCAL_FILE_ITEMS: ReadonlyArray<{ kind: LocalFileKind; label: string; hint: string | null }> = [
  { kind: "appData", label: "应用数据目录", hint: "客户端数据的根目录" },
  { kind: "xray", label: "Xray 内核", hint: null },
  { kind: "geoip", label: "GEO 数据（geoip.dat）", hint: null },
  { kind: "geosite", label: "GEO 数据（geosite.dat）", hint: null },
  { kind: "runtime", label: "运行时目录", hint: "生成的配置、日志与进程记录" },
  { kind: "updater", label: "更新目录", hint: "更新包下载与安装报告" }
];

const KNOWN_KINDS = new Set<LocalFileKind>(LOCAL_FILE_ITEMS.map((item) => item.kind));

/** 只有 macOS 和 Windows 有可浏览的应用目录。 */
export function supportsLocalFiles(platformTarget: string | null | undefined) {
  return platformTarget === "macos" || platformTarget === "windows";
}

/** 更新中心“运行组件”行对应的文件：GEO 两个文件在同一目录，选中 geoip.dat 即可。 */
export function localFileKindForComponent(key: "xray" | "geo"): LocalFileKind {
  return key === "xray" ? "xray" : "geoip";
}

export function isCredentialPath(path: string) {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  return name === "session.json" || name.startsWith("session.json.");
}

export function formatFileSize(bytes: number | null | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** “已安装”“最新版本”这类占位文案不是版本号，不在文件行里显示。 */
export function meaningfulVersionLabel(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text && /\d/.test(text) ? text : null;
}

/** 版本来自已有的组件检查结果与本地记录，不额外请求服务端。 */
export function resolveLocalFileVersions(input: {
  summaryXray?: string | null;
  summaryGeo?: string | null;
  storedXray?: string | null;
  storedGeo?: string | null;
}): LocalFileVersions {
  return {
    xray: meaningfulVersionLabel(input.summaryXray) ?? meaningfulVersionLabel(input.storedXray),
    geo: meaningfulVersionLabel(input.storedGeo) ?? meaningfulVersionLabel(input.summaryGeo)
  };
}

export function buildLocalFileRows(entries: readonly LocalFileEntry[] | null | undefined, versions: LocalFileVersions = {}): LocalFileRow[] {
  const byKind = new Map<LocalFileKind, LocalFileEntry>();
  for (const entry of entries ?? []) {
    // 只认固定条目；即使原生端返回了意外的凭据路径也不展示。
    if (!KNOWN_KINDS.has(entry.kind) || !entry.path || isCredentialPath(entry.path)) continue;
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, entry);
  }
  return LOCAL_FILE_ITEMS.flatMap((item) => {
    const entry = byKind.get(item.kind);
    if (!entry) return [];
    const version = item.kind === "xray" ? versions.xray : item.kind === "geoip" || item.kind === "geosite" ? versions.geo : null;
    let status: string | null = null;
    if (!entry.exists) {
      status = entry.isDirectory ? "尚未创建" : "尚未下载";
    } else if (!entry.isDirectory) {
      status = [formatFileSize(entry.sizeBytes), version ? `版本 ${version}` : null].filter(Boolean).join(" · ") || null;
    }
    return [{
      kind: item.kind,
      label: item.label,
      hint: item.hint,
      path: entry.path,
      isDirectory: entry.isDirectory,
      exists: entry.exists,
      status,
      revealLabel: entry.exists ? (entry.isDirectory ? "打开文件夹" : "在文件夹中显示") : "打开上级目录"
    }];
  });
}
