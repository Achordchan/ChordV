export const DEFAULT_LOCAL_API_BASE = "http://127.0.0.1:3100";

export function resolveLocalApiBase(value: unknown): string {
  return resolveClientApiBase(value, false);
}

export function resolveClientApiBase(value: unknown, releaseBuild = false): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_LOCAL_API_BASE;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("本地 API 地址格式无效。"); }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (!releaseBuild && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) throw new Error("当前为本地重构版本，API 只能指向本机地址。");
  if (releaseBuild && (url.protocol !== "https:" || raw === DEFAULT_LOCAL_API_BASE)) {
    throw new Error("正式构建必须显式提供 HTTPS API 地址。");
  }
  return url.origin;
}
