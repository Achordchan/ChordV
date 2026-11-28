import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Listener = (event: { payload: unknown }) => void;

function loadLifecycle(native = true, failAt?: string) {
  const handlers = new Map<string, Listener>();
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL("../src/lib/nativeLifecycle.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require(name: string) {
      assert.equal(name, "./nativeBridge");
      return {
        isNativeDesktop: () => native,
        async listenNative(name: string, handler: Listener) {
          if (name === failAt) throw new Error("bridge unavailable");
          handlers.set(name, handler);
          return () => handlers.delete(name);
        }
      };
    }
  });
  return { lifecycle: exports, handlers };
}

const { lifecycle, handlers } = loadLifecycle();
const notices: any[] = [];
const stop = await lifecycle.subscribeNativeLifecycleNotices((notice: any) => notices.push(notice));
assert.equal(handlers.size, 4);
const send = (kind: string, payload: unknown) => handlers.get(`chordv://${kind}`)?.({ payload });

for (const cause of ["watchdog-exited", "kernel-exited", "lease-ended"]) {
  for (const proxyRestored of [true, false]) {
    const message = proxyRestored ? "代理恢复进程已退出，连接已断开，请重新连接。" : "系统代理恢复未完成，请重试断开连接。原因：permission denied";
    send("runtime-interrupted", { cause, proxyRestored, message });
    const notice = notices.at(-1);
    assert.equal(notice.kind, "runtime-interrupted");
    assert.equal(notice.cause, cause);
    assert.equal(notice.proxyRestored, proxyRestored);
    const presentation = lifecycle.nativeLifecyclePresentation(notice);
    assert.equal(presentation.title, proxyRestored ? "连接已断开" : "系统代理待恢复");
    assert.equal(presentation.tone, proxyRestored ? "warning" : "danger");
    assert.equal(presentation.message, message, "保留具体原因与恢复建议，不追加退出建议");
    assert.doesNotMatch(`${presentation.title}${presentation.message}`, /退出 ChordV|退出未完成|。。/);
  }
}

send("exit-cleanup-failed", "permission denied。");
const exitPresentation = lifecycle.nativeLifecyclePresentation(notices.at(-1));
assert.equal(exitPresentation.title, "退出未完成");
assert.match(exitPresentation.message, /再次选择“退出 ChordV”重试/);
assert.doesNotMatch(exitPresentation.message, /。。/);

send("startup-recovery-failed", "journal restore denied。");
const startupPresentation = lifecycle.nativeLifecyclePresentation(notices.at(-1));
assert.equal(startupPresentation.title, "启动恢复未完成");
assert.match(startupPresentation.message, /journal restore denied。请重试断开连接/);
assert.doesNotMatch(startupPresentation.message, /退出 ChordV/);

send("shell-tray-unavailable", "系统托盘创建失败，关闭窗口后请从程序坞重新打开");
const trayPresentation = lifecycle.nativeLifecyclePresentation(notices.at(-1));
assert.equal(trayPresentation.title, "系统托盘不可用");
assert.match(trayPresentation.message, /程序坞重新打开/);
assert.doesNotMatch(trayPresentation.message, /退出 ChordV/);

const count = notices.length;
for (const malformed of [null, "legacy", {}, { cause: "other", proxyRestored: true, message: "bad" },
  { cause: "watchdog-exited", proxyRestored: "true", message: "bad" }]) send("runtime-interrupted", malformed);
send("exit-cleanup-failed", { message: "bad" });
assert.equal(notices.length, count, "无上下文或错误类型的载荷不应显示为某次退出失败");
stop();
assert.equal(handlers.size, 0);
const web = loadLifecycle(false);
(await web.lifecycle.subscribeNativeLifecycleNotices(() => assert.fail("web event")))();
assert.equal(web.handlers.size, 0);
const failed = loadLifecycle(true, "chordv://runtime-interrupted");
await assert.rejects(failed.lifecycle.subscribeNativeLifecycleNotices(() => {}), /bridge unavailable/);
assert.equal(failed.handlers.size, 0, "部分订阅失败后清理已建立的监听");

const nativeFile = (name: string) => readFileSync(new URL(`../native/${name}`, import.meta.url), "utf8");
for (const file of ["runtime.go", "main.go", "shell.go"]) {
  assert.doesNotMatch(nativeFile(file), /publish\("chordv:\/\/exit-cleanup-failed"/, `${file}不能冒充用户退出`);
}
assert.match(nativeFile("service.go"), /func \(s \*DesktopService\) shutdown\(\) error \{[\s\S]*?publish\("chordv:\/\/exit-cleanup-failed"/);
assert.match(nativeFile("main.go"), /publish\("chordv:\/\/startup-recovery-failed"/);
assert.match(nativeFile("shell.go"), /publish\("chordv:\/\/shell-tray-unavailable"/);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(app, /subscribeNativeLifecycleNotices\(notice=>\{\s*if\(!disposed\)setNativeLifecycleNotice\(notice\)/);
assert.doesNotMatch(app, /subscribeNativeExitFailure|nativeLifecycleToast|title:"退出未完成"/);
assert.match(app, /desktop-main\$\{nativeLifecycleNotice \? " desktop-main--lifecycle-feedback" : ""\}/);
assert.match(app, /lifecycleFeedback=\{nativeLifecycleNotice \? \{ notice: nativeLifecycleNotice, onDismiss:/);
const tree = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let recoveryEffect = "";
function findRecovery(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" &&
    node.arguments[0]?.getText(tree).includes('notice?.kind === "runtime-interrupted"')) {
    recoveryEffect = node.arguments[0].getText(tree);
    assert.equal(node.arguments[1]?.getText(tree), "[desktopStatus.status]", "只在确认运行状态变化后清理，不因中断通知刚到达时旧connected状态仍在而清理");
  }
  ts.forEachChild(node, findRecovery);
}
findRecovery(tree);
assert.ok(recoveryEffect);
const recoveryCode = ts.transpileModule(`const effect=${recoveryEffect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const status of ["idle", "error", "connecting", "connected"]) {
  for (const kind of ["runtime-interrupted", "exit-cleanup-failed", "startup-recovery-failed", "shell-tray-unavailable"]) {
    const previous = { kind, message: "original cause", cause: "watchdog-exited", proxyRestored: true };
    let next: unknown = previous;
    const effect = new Function("desktopStatus", "setNativeLifecycleNotice", `${recoveryCode};return effect;`)(
      { status }, (update: (notice: unknown) => unknown) => { next = update(next); });
    effect();
    assert.equal(next, status === "connected" && kind === "runtime-interrupted" ? null : previous,
      "仅成功重连清除旧运行中断；连接中、失败及其他原因提示保留");
  }
}
console.log("原生生命周期事件：运行中断、恢复待重试、启动恢复、托盘与实际退出语义及订阅清理检查通过");
