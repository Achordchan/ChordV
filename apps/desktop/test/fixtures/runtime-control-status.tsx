import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import type { GeneratedRuntimeConfigDto } from "@chordv/shared";
import "@mantine/core/styles.css";
import "../../src/styles.css";
import { ControlPanel } from "../../src/components/ControlPanel";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";

// 仅测试真实组件展示：故意保留旧runtime配置；不创建进程或原生桥。
const config: GeneratedRuntimeConfigDto = {
  sessionId: "test-only-session", leaseId: "test-only-lease", leaseExpiresAt: "2099-01-01T00:00:00Z",
  leaseHeartbeatIntervalSeconds: 30, leaseGraceSeconds: 120, mode: "global", localHttpPort: 17890, localSocksPort: 17891,
  routingProfile: "test-only", generatedAt: "2026-11-17T00:00:00Z", features: { blockAds: false, chinaDirect: false, aiServicesProxy: false },
  customRoutingRules: [], node: { id: "test-only-node", name: "组件测试节点", countryCode: null, region: "本地", provider: "test-only",
    tags: [], recommended: false, latencyMs: 1, protocol: "vless", security: "reality" },
  outbound: { protocol: "vless", server: "127.0.0.1", port: 1, uuid: "test-only", flow: "", realityPublicKey: "test-only",
    shortId: "", serverName: "test.invalid", fingerprint: "chrome", spiderX: "/" }
};
const scenarios = ["connected", "error-stopped", "idle-ready", "error-running", "connecting", "idle-completed", "idle-stale-pid", "connected-missing-pid", "android-connected", "android-stopped"] as const;
type Scenario = typeof scenarios[number];
function Fixture() {
  const [scenario, setScenario] = useState<Scenario>("connected");
  const android = scenario.startsWith("android");
  const status = scenario.startsWith("idle") ? "idle" : scenario === "connecting" ? "connecting" : scenario.includes("error") || scenario === "android-stopped" ? "error" : "connected";
  const desktopStatus = { ...createIdleRuntimeStatus(android ? "android" : "macos"), status,
    activePid: ["connected", "error-running", "idle-stale-pid"].includes(scenario) ? 4242 : null,
    xrayBinaryPath: scenario.startsWith("idle") && scenario !== "idle-stale-pid" || android ? null : "/test-only/xray",
    vpnActive: android ? scenario === "android-connected" : null };
  return <MantineProvider>
    <div>{scenarios.map(value => <button key={value} onClick={() => setScenario(value)}>{value}</button>)}</div>
    <div style={{ width: "min(400px, 100%)", height: "calc(100dvh - 150px)", padding: 12, boxSizing: "border-box" }}>
      <ControlPanel modes={["rule", "global", "direct"]} mode="global" canConnect={status === "idle"} modeLocked={status !== "idle"}
        primaryBusy={false} primaryLabel={status === "error" ? "断开连接" : status === "connected" ? "断开连接" : "启动连接"}
        desktopStatus={desktopStatus} runtime={config} error={status === "error" ? "连接发生异常，请先清理连接。" : null}
        runtimeAssetsPhase={scenario === "idle-completed" ? "completed" : "ready"}
        onModeChange={() => {}} onPrimaryAction={() => {}} onOpenRoutingRules={() => {}} onOpenLogs={() => {}} />
    </div>
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
