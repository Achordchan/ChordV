import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPresenceNudges } from "../src/lib/presenceNudges";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

class FakeTarget {
  readonly listeners = new Map<string, Set<() => void>>();
  visibilityState = "visible";
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener();
  }
  count() {
    return Array.from(this.listeners.values()).reduce((total, set) => total + set.size, 0);
  }
}

async function testNudgesStartOnLoginAndStopOnLogout() {
  const windowTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  let nudges = 0;
  const stop = startPresenceNudges({ windowTarget, documentTarget, nudge: () => { nudges += 1; } });
  assert.equal(windowTarget.count() + documentTarget.count(), 2, "登录后监听网络恢复与窗口重新显示");

  windowTarget.dispatch("online");
  assert.equal(nudges, 1, "网络恢复时补报一次");
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");
  assert.equal(nudges, 1, "窗口隐藏到托盘时不补报");
  documentTarget.visibilityState = "visible";
  documentTarget.dispatch("visibilitychange");
  assert.equal(nudges, 2, "窗口重新显示时补报一次");

  stop();
  assert.equal(windowTarget.count() + documentTarget.count(), 0, "退出登录后移除全部监听");
  windowTarget.dispatch("online");
  documentTarget.dispatch("visibilitychange");
  assert.equal(nudges, 2, "退出登录后不再补报");
}

async function testNudgeFailureIsSilent() {
  const windowTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const stopRejecting = startPresenceNudges({ windowTarget, documentTarget, nudge: () => Promise.reject(new Error("offline")) });
    windowTarget.dispatch("online");
    stopRejecting();
    const stopThrowing = startPresenceNudges({ windowTarget, documentTarget, nudge: () => { throw new Error("no native shell"); } });
    assert.doesNotThrow(() => windowTarget.dispatch("online"), "补报失败不抛出");
    stopThrowing();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, [], "补报失败静默忽略，不产生未处理的异常");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

function testWiring() {
  const hook = read("src/hooks/useClientEvents.ts");
  assert.match(hook, /startPresenceNudges\(\{ windowTarget: window, documentTarget: document, nudge: nudgeClientPresence \}\)/, "登录期间接入补报");
  assert.match(hook, /\}, \[session\?\.accessToken, nudgeClientPresence\]\);/, "随登录态开始、退出登录时清理");

  const client = read("src/api/client.ts");
  const nudge = client.slice(client.indexOf("export async function nudgeClientPresence"), client.indexOf("function normalizeHeaders"));
  assert.match(nudge, /invoke\("nudge_client_presence"\)/);
  assert.match(nudge, /catch \{/, "原生补报失败不影响客户端");
  assert.doesNotMatch(client, /events\/stream\?presence=ping/, "网页兜底连接不声明定期上报（不在网页里定期上报）");

  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /let url = presence_keepalive::event_stream_url\(&api_base_url\(\)\);/, "原生推送连接带上声明");
  const opened = lib.indexOf("emit_client_event_stream_opened(&app, &stream_id);\n    // 连接建立后开始定期上报在线");
  assert.ok(opened > 0, "连接建立后才开始上报");
  assert.match(lib.slice(opened, opened + 800), /let _presence = presence_keepalive::spawn_presence_keepalive\(/, "上报任务与推送连接同生共死（函数返回即停止）");
  assert.match(lib, /nudge_client_presence,\n/, "注册补报命令");
}

async function main() {
  await testNudgesStartOnLoginAndStopOnLogout();
  await testNudgeFailureIsSilent();
  testWiring();
  console.log("presence keepalive regression checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
