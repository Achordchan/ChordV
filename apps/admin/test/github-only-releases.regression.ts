import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
function sources(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(new URL(`${entry.name}/`, directory))
    : /\.(?:ts|tsx)$/.test(entry.name) ? [readFileSync(new URL(entry.name, directory), "utf8")] : []);
}
test("后台移除发布中心和在线自更新控制入口", () => {
  const app = read("src/App.tsx");
  assert.doesNotMatch(app, /UnifiedReleaseCenter|SystemUpdateBadge|label: "发布中心"|section === "releases"/);
  assert.match(app, /<GitHubVersion\s*\/>/);
  for (const path of ["src/features/releases", "src/features/runtime-components", "src/features/system-update", "src/pages/ReleasesPage.tsx"]) assert.equal(existsSync(new URL(path, root)), false, path);
  for (const source of sources(new URL("src/", root))) assert.doesNotMatch(source, /["'`]\/admin\/(?:releases|runtime-components|runtime-versions|system\/(?:update|rollback|restart))/);
});
test("版本仅链接GitHub且不发起后台发布请求", () => {
  const component = read("src/components/GitHubVersion.tsx");
  assert.match(component, /VITE_GITHUB_RELEASE_REPOSITORY/);
  assert.match(component, /https:\/\/github\.com/);
  assert.match(component, /isGitHubReleaseRepository\(repository\)/);
  assert.doesNotMatch(component, /fetch\(|request\(|setInterval|token/i);
  assert.match(component, /noopener noreferrer/);
});
test("开发代理默认隔离到Go本地服务且不加载旧env", () => {
  const config = read("vite.config.ts");
  assert.match(config, /127\.0\.0\.1:3100/);
  assert.match(config, /\.data\/mygo\/frontend-env/);
  assert.match(config, /本地调试后台只允许连接回环地址/);
  assert.doesNotMatch(config, /v\.achord\.cn/);
});
