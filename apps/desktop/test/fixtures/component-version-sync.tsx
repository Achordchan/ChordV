import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useComponentVersionSync } from "../../src/hooks/useComponentVersionSync";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";
import type { RuntimeAssetsCheckSummary } from "../../src/hooks/useRuntimeAssets";

// 真实 hook 的测试原生边界和手动应答，不由生产入口加载、不连接真实内核或仓库。
let calls = 0, reads = 0, active = 0, maximum = 0, nativeConnected = false;
const pending: Array<{ resolve: (success: boolean) => void; reject: () => void }> = [];
Object.assign(window, { mygo: {
  platform: "darwin", on: () => () => {},
  call: async (_method: string, command: string) => {
    if (command !== "runtime_status") throw new Error(`Unexpected test-only command: ${command}`);
    reads++;
    return { ...createIdleRuntimeStatus("macos"), status: nativeConnected ? "connected" : "idle" };
  }
} });

function Fixture() {
  const [token, setToken] = useState<string | null>("test-only-initial-token");
  const [status, setStatus] = useState(() => createIdleRuntimeStatus("macos"));
  const [busy, setBusy] = useState(false);
  const sync = useComponentVersionSync({ enabled: true, accessToken: token, status, assetsBusy: busy, applicationUpdateBusy: false,
    onStatus: setStatus, ensure: () => {
      calls++; active++; maximum = Math.max(maximum, active);
      return new Promise((resolve, reject) => pending.push({
        resolve: success => { active--; resolve(success); }, reject: () => { active--; reject(new Error("test-only failure")); }
      }));
    }
  });
  Object.assign(window, { componentSyncFixture: {
    snapshot: () => ({ calls, reads, active, maximum, ...sync, accessToken: token, status: status.status, busy }),
    request: (platform = "macos") => sync.requestSync({ type: "runtime_component_updated", platform, occurredAt: new Date().toISOString() } as never),
    resolve: (success: boolean) => pending.shift()!.resolve(success), reject: () => pending.shift()!.reject(),
    busy: setBusy, logout: () => setToken(null), login: () => setToken("test-only-next-token"),
    nativeConnected: (value: boolean) => { nativeConnected = value; },
    disconnect: () => { nativeConnected = false; setStatus(createIdleRuntimeStatus("macos")); },
    manualSuccess: () => sync.reportManualSyncResult(token, true, {
      checked: true, updated: [], failed: [], current: true, releaseTag: "v1.1.12",
      xray: { localVersion: "26.11.9", remoteVersion: "26.11.9", current: true, available: false, message: "已就绪" },
      geo: { localVersion: "20261115", remoteVersion: "20261115", current: true, available: false, message: "已就绪" }
    } satisfies RuntimeAssetsCheckSummary),
    unmount: () => root.unmount()
  } });
  return <output>组件巡检测试夹具</output>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
