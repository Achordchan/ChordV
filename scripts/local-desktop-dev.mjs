import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiBaseUrl = (process.env.CHORDV_API_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const corepack = "corepack";

await waitForApi(apiBaseUrl);
if (localRuntimeAssetsReady()) {
  process.stdout.write("\u684c\u9762\u5ba2\u6237\u7aef\u8fd0\u884c\u7ec4\u4ef6\u5df2\u5c31\u7eea\u3002\n");
} else {
  const runtimeComponentApiBaseUrl = await resolveRuntimeComponentApiBaseUrl();
  await runPnpm(["--filter", "@chordv/desktop", "setup:xray"], {
    CHORDV_API_BASE_URL: runtimeComponentApiBaseUrl,
    VITE_API_BASE_URL: runtimeComponentApiBaseUrl
  });
}
await runPnpm(["--filter", "@chordv/desktop", "tauri:dev"]);

async function waitForApi(baseUrl) {
  const deadline = Date.now() + 45_000;
  process.stdout.write(`\u7b49\u5f85\u672c\u5730 API \u5c31\u7eea\uff1a${baseUrl}\n`);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_500) });
      await response.body?.cancel();
      process.stdout.write("\u672c\u5730 API \u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u51c6\u5907\u684c\u9762\u5ba2\u6237\u7aef\u3002\n");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`\u672c\u5730 API \u5728 45 \u79d2\u5185\u672a\u5c31\u7eea\uff1a${baseUrl}`);
}

async function resolveRuntimeComponentApiBaseUrl() {
  const platform = process.platform === "win32" ? "windows" : "macos";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const planUrl =
    `${apiBaseUrl}/api/client/runtime-components/plan?platform=${encodeURIComponent(platform)}&architecture=${encodeURIComponent(architecture)}`;

  try {
    const response = await fetch(planUrl, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const plan = await response.json();
      const kinds = new Set((plan.components || []).map((component) => component.kind));
      if (["xray", "geoip", "geosite"].every((kind) => kinds.has(kind))) {
        return apiBaseUrl;
      }
    }
  } catch {}

  const fallback =
    process.env.CHORDV_RUNTIME_COMPONENT_API_BASE_URL?.trim() || "https://v.baymaxgroup.com";
  process.stdout.write(
    `\u672c\u5730 API \u672a\u914d\u7f6e\u5b8c\u6574\u8fd0\u884c\u7ec4\u4ef6\uff0c\u5c06\u4ece\u7ec4\u4ef6\u670d\u52a1\u51c6\u5907\uff1a${fallback}\n`
  );
  return fallback.replace(/\/+$/, "");
}

function localRuntimeAssetsReady() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const binDir = path.resolve(scriptDir, "../apps/desktop/src-tauri/bin");
  const xrayName =
    process.platform === "win32"
      ? "xray.exe"
      : process.arch === "arm64"
        ? "xray-aarch64-apple-darwin"
        : "xray-x86_64-apple-darwin";
  const files = [
    { path: path.join(binDir, xrayName), minimumBytes: 1024 * 1024 },
    { path: path.join(binDir, "geoip.dat"), minimumBytes: 64 * 1024 },
    { path: path.join(binDir, "geosite.dat"), minimumBytes: 64 * 1024 }
  ];

  if (!files.every((file) => existsSync(file.path) && statSync(file.path).size >= file.minimumBytes)) {
    return false;
  }
  if (process.platform === "win32") {
    return readFileSync(files[0].path).subarray(0, 2).toString("ascii") === "MZ";
  }
  return true;
}

function runPnpm(args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(corepack, ["pnpm", ...args], {
      env: { ...process.env, ...envOverrides },
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    const forwardSignal = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const forwardInt = () => forwardSignal("SIGINT");
    const forwardTerm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", forwardInt);
    process.once("SIGTERM", forwardTerm);

    const cleanup = () => {
      process.removeListener("SIGINT", forwardInt);
      process.removeListener("SIGTERM", forwardTerm);
    };

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        reject(new Error(`\u684c\u9762\u5ba2\u6237\u7aef\u8fdb\u7a0b\u88ab\u4fe1\u53f7 ${signal} \u7ec8\u6b62`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`corepack pnpm ${args.join(" ")} \u9000\u51fa\u7801\u4e3a ${code}`));
        return;
      }
      resolve();
    });
  });
}
