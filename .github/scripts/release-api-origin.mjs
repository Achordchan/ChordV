export function releaseAPIOrigin(value) {
  // Check the raw input before URL normalization can erase dot segments or empty queries.
  if (typeof value === "string" && /^https:\/\/[^/\\?#@\s]+\/?$/i.test(value)) {
    try { return new URL(value).origin; } catch { /* Report without echoing configuration. */ }
  }
  throw new Error("正式构建必须显式提供不含路径、查询参数、片段或凭据的 HTTPS API 来源");
}
