import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "./mygo-local-config.mjs";
import { buildAgentDistribution } from "./agent-release-assets.mjs";

const args = process.argv.slice(2);
const options = { release: false, platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform, arch: process.arch === "x64" ? "x64" : process.arch };
for (let index = 0; index < args.length; index++) {
  if(args[index] === "--release") { options.release=true; continue; }
  const key = args[index].replace(/^--/, "");
  if (!["platform", "arch"].includes(key) || !args[index + 1]) throw new Error("用法：node scripts/mygo-build-backend.mjs [--platform linux|macos|windows] [--arch x64|arm64] [--release]");
  options[key] = args[++index];
}
const goOS = { linux: "linux", macos: "darwin", windows: "windows" }[options.platform];
const goArch = { x64: "amd64", arm64: "arm64" }[options.arch];
if (!goOS || !goArch) throw new Error("不支持的服务端平台或架构");
const sourceVersion = (await readFile(path.join(PROJECT_ROOT, "SYSTEM_VERSION"), "utf8")).trim();
const version = process.env.VERSION?.trim() || sourceVersion;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version) || version !== sourceVersion) {
  throw new Error("服务端版本必须是与 SYSTEM_VERSION 一致的 SemVer");
}
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" });
if (revision.status !== 0 || !/^[a-f0-9]{40,64}$/.test(revision.stdout.trim())) throw new Error("读取服务端 Git 提交失败");
const commit = revision.stdout.trim();
const builtAt = new Date().toISOString();
const buildPackage = "github.com/Achordchan/ChordV/apps/server/internal/buildinfo";
const target = path.join(PROJECT_ROOT, "output/backend", `${options.platform}-${options.arch}`);
const run = (command, commandArgs, cwd, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, commandArgs, { cwd, env: { ...process.env, ...extraEnv }, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" && command.endsWith(".cmd") });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} 构建失败（${code}）`)));
});
await mkdir(target, { recursive: true });
const agentManifestSHA256 = await buildAgentDistribution(path.join(target, "agent-dist"), { version, commit });
const ldflags = `-s -w -X ${buildPackage}.Version=${version} -X ${buildPackage}.Commit=${commit} -X ${buildPackage}.BuiltAt=${builtAt} -X ${buildPackage}.AgentManifestSHA256=${agentManifestSHA256}`;
const binary = path.join(target, goOS === "windows" ? "chordv-server.exe" : "chordv-server");
await run("go", ["build", `-ldflags=${ldflags}`, "-o", binary, "./cmd/chordv-server"], path.join(PROJECT_ROOT, "apps/server"), { GOOS: goOS, GOARCH: goArch, CGO_ENABLED: "0" });
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
await run(pnpm, ["--filter", "@chordv/admin", "build"], PROJECT_ROOT);
await rm(path.join(target, "admin"), { recursive: true, force: true });
await cp(path.join(PROJECT_ROOT, "apps/admin/dist"), path.join(target, "admin"), { recursive: true });
await cp(path.join(PROJECT_ROOT,"apps/server/README.md"),path.join(target,"SERVER-CONFIG.md"));
await writeFile(path.join(target, "build-info.json"), JSON.stringify({ version, commit, builtAt, platform: options.platform, architecture: options.arch }, null, 2) + "\n");
await rm(path.join(target, options.release ? "LOCAL-ONLY.txt" : "DEPLOYMENT.txt"), { force: true });
await writeFile(path.join(target, options.release ? "DEPLOYMENT.txt" : "LOCAL-ONLY.txt"), options.release
 ? "仅构建，未启动、部署或迁移数据库。默认 CHORDV_MODE=local；生产运行必须显式设置 CHORDV_MODE=production 及专用 CHORDV_LISTEN/DATABASE_URL/JWT_SECRET/AGENT_PEPPER/DATA_DIR/PUBLIC_ORIGIN/ALLOWED_ORIGINS/TRUSTED_PROXIES 配置。完整配置见 SERVER-CONFIG.md；不要使用旧 DATABASE_URL 或根.env。反向代理负责 HTTPS；不包含数据库、凭据或 Node.js。\n"
 : "本包仅供本地隔离调试。不要自动部署到线上。显式配置 CHORDV_MODE=local 和 CHORDV_LOCAL_*；不包含数据库、凭据或 Node.js。\n");
process.stdout.write(`Go 服务端与后台静态文件已构建：${target}\n`);
