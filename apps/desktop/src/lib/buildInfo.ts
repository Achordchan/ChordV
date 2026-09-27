// CI embeds the build number at package time. The version stays plain (1.1.10);
// the build only orders successive installers of that version.
export function parseBuildNumber(raw: unknown) {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

export const APP_BUILD_NUMBER = parseBuildNumber(import.meta.env?.VITE_APP_BUILD_NUMBER);

/** "1.1.10 · 构建 42"; the build is only shown when known. */
export function formatVersionWithBuild(version: string, build: number | null | undefined) {
  return build ? `${version} · 构建 ${build}` : version;
}
