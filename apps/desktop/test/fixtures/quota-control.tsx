import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import type { SubscriptionStatusDto } from "@chordv/shared";
import "@mantine/core/styles.css";
import "../../src/styles.css";
import { ControlPanel } from "../../src/components/ControlPanel";
import { isSubscriptionBlocked } from "../../src/lib/connectionGuidance";
import { primaryButtonLabel } from "../../src/lib/appState";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";
import { createIdleRuntimeAssetsState } from "../../src/lib/runtimeComponents";

// 仅组件回归：其余连接条件固定，只切换订阅额度与组件下载状态；无原生桥、文件安装或物理连接。
function Fixture() {
  const [exhausted, setExhausted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const subscription: SubscriptionStatusDto = {
    ownerType: "user", planId: "test-only-plan", planName: "测试套餐", totalTrafficGb: 1,
    usedTrafficGb: exhausted ? 1 : 0, remainingTrafficGb: exhausted ? 0 : 1,
    state: exhausted ? "exhausted" : "active", expireAt: "2099-01-01T00:00:00Z",
    renewable: true, lastSyncedAt: "2026-11-17T00:00:00Z", meteringStatus: "ok"
  };
  const assets = { ...createIdleRuntimeAssetsState(), phase: failed ? "failed" as const : "ready" as const };
  return <MantineProvider>
    <button onClick={() => setExhausted(true)}>测试：耗尽额度</button>
    <button onClick={() => setExhausted(false)}>测试：恢复额度</button>
    <button onClick={() => setFailed(true)}>测试：组件下载失败</button>
    <output data-testid="attempts">{attempts}</output>
    <div style={{ width: 400, height: 500, padding: 12 }}>
      <ControlPanel modes={["rule", "global", "direct"]} mode="rule" modeLocked={false}
        canConnect={!isSubscriptionBlocked(subscription)} primaryBusy={false}
        primaryLabel={primaryButtonLabel("idle", subscription, null, false, assets, "macos")}
        desktopStatus={createIdleRuntimeStatus("macos")} runtime={null} error={null} runtimeAssetsPhase={assets.phase}
        onModeChange={() => {}} onPrimaryAction={() => setAttempts(value => value + 1)}
        onOpenRoutingRules={() => {}} onOpenLogs={() => {}} />
    </div>
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
