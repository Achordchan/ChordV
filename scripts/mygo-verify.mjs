import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureLocalDatabase } from "./mygo-local-db.mjs";
import { loadLocalEnvironment, PROJECT_ROOT } from "./mygo-local-config.mjs";

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || ![undefined, "--check", "--browser", "--desktop-ui", "--admin-ui"].includes(mode)) throw new Error("参数只能为 --check、--browser、--desktop-ui 或 --admin-ui");
const checkOnly = mode === "--check";
const full = mode === undefined;
const nativeChecks = full || checkOnly;
const uiApp = mode === "--desktop-ui" ? "desktop" : mode === "--admin-ui" ? "admin" : null;
const uiDirectories = uiApp ? [`apps/${uiApp}/test`] : ["apps/desktop/test", "apps/admin/test"];
const local = nativeChecks ? await loadLocalEnvironment() : {};
const env = { ...process.env, ...local, CGO_ENABLED: "0", TSX_TSCONFIG_PATH: path.join(PROJECT_ROOT, "tsconfig.base.json") };
if (!env.PLAYWRIGHT_CHANNEL && existsSync("/Applications/Google Chrome.app")) env.PLAYWRIGHT_CHANNEL = "chrome";
let database;
let failures = 0;
let completed = 0;
async function run(command, args, cwd = PROJECT_ROOT) {
  const label = `${path.relative(PROJECT_ROOT, cwd) || "."}：${command} ${args.join(" ")}`;
  process.stdout.write(`\n--- ${label} ---\n`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  completed++;
  if (code !== 0) failures++;
}
try {
  if (nativeChecks) await run(process.execPath, ["scripts/mygo-node-country-data.mjs", "--check"]);
  if (full) database = await ensureLocalDatabase(local);
  for (const module of !nativeChecks ? [] : ["packages/release-protocol", "apps/server", "apps/desktop/native", "apps/agent"]) {
    const cwd = path.join(PROJECT_ROOT, module);
    await run("go", ["vet", "./..."], cwd);
    // The packaged desktop fixtures install and launch sequentially; the
    // native suite can exceed Go's default ten-minute package timeout.
    const nativeTimeout = module === "apps/desktop/native" ? ["-timeout=20m"] : [];
    await run("go", checkOnly ? ["test", "-run", "^$", "./..."] : ["test", "-count=1", ...nativeTimeout, "./..."], cwd);
  }
  if (full) {
    const scripts = (await readdir(path.join(PROJECT_ROOT, "scripts"))).filter((name) => name.startsWith("mygo-") && name.endsWith(".test.mjs"));
    await run(process.execPath, ["--test", ...scripts.map((name) => `scripts/${name}`)]);
    const harnessTests = (await readdir(path.join(PROJECT_ROOT, "tests/e2e"))).filter((name) => name.endsWith(".test.mjs"));
    if (harnessTests.length) await run(process.execPath, ["--test", ...harnessTests.map((name) => `tests/e2e/${name}`)]);
    const releaseTests = (await readdir(path.join(PROJECT_ROOT, ".github/scripts"))).filter((name) => name.endsWith(".test.mjs"));
    if (releaseTests.length) await run(process.execPath, ["--test", ...releaseTests.map((name) => `.github/scripts/${name}`)]);
  }
  if (full || uiApp) {
    for (const directory of uiDirectories) {
      const tests = (await readdir(path.join(PROJECT_ROOT, directory))).filter((name) => /\.regression\.(?:ts|mjs)$/.test(name)).sort();
      if (!tests.length) throw new Error(`未发现回归测试：${directory}`);
      for (const name of tests) await run(process.execPath, ["--import", "tsx", `${directory}/${name}`]);
    }
  }
  if (!checkOnly) {
    for (const directory of uiDirectories) {
      const tests = (await readdir(path.join(PROJECT_ROOT, directory))).filter((name) => name.endsWith(".browser.ts")).sort();
      if (!tests.length) throw new Error(`未发现回归测试：${directory}`);
      for (const name of tests) await run(process.execPath, ["--import", "tsx", "--test", `${directory}/${name}`]);
    }
  }
} finally { await database?.stop(); }
process.stdout.write(`\n验证结束：${completed - failures}/${completed} 条命令通过。\n`);
if (failures) process.exitCode = 1;
