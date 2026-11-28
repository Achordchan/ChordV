import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/styles.css";
import { useRuntimeAssets } from "../../src/hooks/useRuntimeAssets";
import { RuntimeAssetsBanner } from "../../src/components/RuntimeAssetsBanner";
import { ControlPanel } from "../../src/components/ControlPanel";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";
import { loadSupportComponentsInfo } from "../../src/lib/supportContextSources";

// 仅测试服务提供此页面和原生边界夹具；生产入口不加载它，也不读真实用户组件。
const files = new URLSearchParams(location.search).get("files") ?? "missing";
const installed = files !== "missing";
let verified = files === "installed" || files === "installed-then-invalid";
localStorage.setItem("chordv.geo.installedVersionLabel", "20261115");
const commands: string[] = [];
Object.assign(window, { mygo: {
  platform: "darwin",
  call: async (_method: string, command: string, payload: { component?: string }) => {
    commands.push(command);
    if (command === "desktop_runtime_environment") return { platform: "macos", architecture: "arm64", runtimeBinDir: "/test-only/runtime" };
    if (command === "get_runtime_component_local_info") return { kind: payload.component, exists: installed,
      ...(files === "legacy-unverified" ? {} : { verified }),
      path: installed ? `/test-only/runtime/${payload.component}` : null, sizeBytes: installed ? 1024 : null,
      checksumSha256: null, versionLabel: installed && payload.component === "xray" ? "26.11.9" : null };
    if (command === "ensure_bundled_runtime_components") return { ready: verified || files === "bundle-claims-ready", runtimeBinDir: "/test-only/runtime", copiedComponents: [], missingComponents: verified ? [] : ["xray", "geoip", "geosite"], message: null };
    throw new Error(`Unexpected test-only native command: ${command}`);
  },
  on: () => () => {}
} });

function RuntimeSourceFixture() {
  const hook = useRuntimeAssets({ appVersion: "1.1.12", platformTarget: "macos" });
  const [report, setReport] = useState<unknown>(null);
  const run = async (source: "startup" | "connect", force = true) => {
    const success = await hook.ensureRuntimeAssetsReady({ source, interactive: source === "connect", blockConnection: source === "connect", inspectOnly: source === "startup", forceCheck: source === "connect" && force });
    setReport({ source, success, summary: hook.getLastRuntimeAssetsCheckSummary(), support: await loadSupportComponentsInfo(), commands: [...commands] });
  };
  useEffect(() => { void run("startup"); }, []);
  const status = { ...createIdleRuntimeStatus("macos"), xrayBinaryPath: installed ? "/test-only/runtime/xray" : null };
  return <MantineProvider defaultColorScheme="light">
    <div style={{ padding: 12 }}>
      <RuntimeAssetsBanner state={hook.runtimeAssets} onRetry={hook.handleRetryRuntimeAssets} />
      <ControlPanel modes={["rule", "global"]} mode="rule" canConnect={hook.runtimeAssetsReady} modeLocked={false}
        primaryBusy={false} primaryLabel={hook.runtimeAssetsReady ? "连接节点" : "未配置组件来源"} desktopStatus={status}
        runtime={null} error={null} runtimeAssetsPhase={hook.runtimeAssets.phase} onModeChange={() => {}}
        onPrimaryAction={() => {}} onOpenRoutingRules={() => {}} onOpenLogs={() => {}} />
      <button onClick={() => void run("connect")}>检查连接前组件</button>
      <button onClick={() => { verified = false; localStorage.setItem("chordv.geo.lastCheckAt", String(Date.now())); }}>模拟本地记录失效</button>
      <button onClick={() => void run("connect", false)}>检查缓存连接</button>
      <output data-testid="runtime-phase" hidden>{hook.runtimeAssets.phase}</output>
      <output data-testid="runtime-ready" hidden>{String(hook.runtimeAssetsReady)}</output>
      <pre data-testid="runtime-report" hidden>{JSON.stringify(report)}</pre>
    </div>
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<RuntimeSourceFixture />);
