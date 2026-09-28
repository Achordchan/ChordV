import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createNotificationsStore, notifications } from "@mantine/notifications";
import { TOAST_LIMIT, TOAST_TONES, toToastModel, toastRole, type ToastInput } from "../src/lib/toast";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

// ---- 数据层：色调、无障碍角色、错误编号拆分 ----

assert.deepEqual([...TOAST_TONES], ["info", "success", "warning", "danger"], "four semantic tones, same as NoticeRow");
assert.equal(toastRole("danger"), "alert");
assert.equal(toastRole("warning"), "alert");
assert.equal(toastRole("info"), "status");
assert.equal(toastRole("success"), "status");

const coded = toToastModel({ tone: "danger", title: "连接失败", message: "请检查网络后重试。\n错误编号：CONNECT_TIMEOUT" });
assert.equal(coded.message, "请检查网络后重试。", "the code line is taken out of the body");
assert.equal(coded.code, "CONNECT_TIMEOUT", "the code is kept as its own secondary line");
assert.equal(coded.role, "alert");
assert.equal(toToastModel({ tone: "danger", message: "登录失败", code: "AUTH_401" }).code, "AUTH_401", "explicit codes pass through");
assert.equal(toToastModel({ tone: "danger", message: "a\n错误编号：X1", code: "X2" }).code, "X2", "an explicit code wins");

const plain = toToastModel({ tone: "info", message: "第一行\n\n第二行" });
assert.equal(plain.message, "第一行\n\n第二行", "messages without a code are not rewritten");
assert.equal(plain.code, null);
assert.equal(plain.title, null);
assert.equal(plain.role, "status");
assert.match(coded.id, /^client-notice-[a-z0-9]+$/, "generated IDs are valid DOM ids (no spaces or quotes)");
assert.equal(toToastModel({ tone: "danger", title: "连接失败", message: "请检查网络后重试。\n错误编号：CONNECT_TIMEOUT" }).id, coded.id, "same content, same ID");
assert.equal("autoClose" in plain, false, "no autoClose override unless the caller sets one");
assert.equal(toToastModel({ tone: "danger", message: "退出失败", autoClose: false }).autoClose, false);
assert.equal(toToastModel({ tone: "info", message: "x", id: "business-id" }).id, "business-id", "business IDs stay intact");

// ---- 去重：没有业务 ID 的相同提示在显示或排队期间只出现一次 ----

const store = createNotificationsStore();
const show = (input: ToastInput) => notifications.show({ ...toToastModel(input), message: input.message }, store);
const notice: ToastInput = { tone: "warning", title: "同步失败", message: "请稍后重试" };
const id = show(notice);
show(notice);
show(notice);
assert.equal(store.getState().notifications.length, 1);
show({ ...notice, tone: "danger" });
assert.equal(store.getState().notifications.length, 2, "a different tone is a different notice");
notifications.hide(id, store);
show(notice);
assert.equal(store.getState().notifications.length, 2, "dismissed notices may recur");
store.setState({ ...store.getState(), limit: 0 });
show({ ...notice, message: "排队消息" });
show({ ...notice, message: "排队消息" });
assert.equal(store.getState().queue.filter((item) => item.message === "排队消息").length, 1);
show({ tone: "danger", id: "persistent", message: "退出失败", autoClose: false });
assert.equal(store.getState().queue.find((item) => item.id === "persistent")?.autoClose, false);

// ---- 源码约束：所有提示都经过 showToast，不再出现 Mantine 默认的彩色竖条样式 ----

const toastComponent = "src/components/Toast.tsx";
for (const file of sourceFiles(resolve(root, "src"))) {
  const path = relative(root, file).replace(/\\/g, "/");
  const source = read(path);
  if (path !== toastComponent && path !== "src/main.tsx") {
    assert.doesNotMatch(source, /@mantine\/notifications/, `${path}: toasts go through showToast`);
  }
  if (path !== toastComponent) {
    assert.doesNotMatch(source, /notifications\.show\(/, `${path}: no raw notifications.show`);
    assert.doesNotMatch(source, /<Notification\b/, `${path}: no ad-hoc Notification cards`);
  }
  assert.doesNotMatch(source, /(?:showToast|notify)\??\.?\(\{[^}]*\bcolor\s*:/, `${path}: toasts use semantic tones, not raw colours`);
  assert.doesNotMatch(source, /toneToToastColor/, `${path}: guidance tones are already toast tones`);
}

const toast = read(toastComponent);
assert.match(toast, /import \{ toneIcon \} from "\.\/NoticeRow"/, "same status icons as NoticeRow / AppDialog");
assert.match(toast, /icon: <Icon size=\{18\}/);
assert.match(toast, /<ErrorCodeHint code=\{toast\.code\} \/>/, "error codes render like ErrorCodeHint elsewhere");
assert.match(toast, /role: toast\.role/);
assert.match(toast, /"aria-live": toast\.role === "alert" \? "assertive" : "polite"/);
assert.match(toast, /"data-tone": toast\.tone/);
assert.match(toast, /"aria-label": "关闭提示"/);
assert.match(toast, /id: toast\.id/, "deduplication IDs reach the store");

const css = read("src/components/Toast.module.css");
assert.match(css, /\.toast\[data-tone\]::before \{ display: none; \}/, "no coloured bar on the left edge");
assert.match(css, /\.toast\[data-tone\] \{[^}]*border: 1px solid var\(--cv-border\);[^}]*border-radius: var\(--cv-radius-lg\);[^}]*background: var\(--cv-surface\);[^}]*box-shadow: var\(--cv-shadow-lg\);/);
for (const tone of ["success", "warning", "danger"]) {
  assert.match(css, new RegExp(`\\.toast\\[data-tone="${tone}"\\] \\{ --toast-icon: var\\(--cv-icon-${tone}\\); \\}`), `${tone} icon colour`);
}
assert.match(css, /--toast-icon: var\(--cv-icon-info\);/, "info is the default icon colour");
assert.match(css, /\.icon \{[^}]*background: none;[^}]*color: var\(--toast-icon\);/, "bare icon instead of Mantine's filled circle");
assert.match(css, /\.description \{[^}]*white-space: pre-line;/);
assert.match(css, /\.desktop-app--mac-titlebar\)\) \.container\[data-position="top-right"\] \{ top: 38px; \}/, "toasts start below the macOS title bar");
// 1.1.11 构建 22 的 P0：容器类名会套到 Mantine 全部 6 个位置容器上。底部容器被加上 top 后上下撑满窗口，
// 透明却接收鼠标，所有按钮都点不动。容器必须不接收鼠标，位置只能改右上角那一个。
{
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const bare = rules.filter(rule => /(^|[\s,)])\.container\s*$/.test(rule.selector));
  assert.ok(bare.length > 0 && bare.every(rule => /pointer-events:\s*none/.test(rule.body) && !/\b(top|bottom|left|right|inset|height)\s*:/.test(rule.body)),
    "the shared container class only disables pointer events and never positions every container");
  for (const rule of rules.filter(rule => /\.container\b/.test(rule.selector) && /\b(top|bottom|left|right|inset)\s*:/.test(rule.body))) {
    assert.match(rule.selector, /\.container\[data-position="top-right"\]/, `positioning must target the top-right container only: ${rule.selector}`);
  }
  assert.ok(rules.some(rule => /^\.item$/.test(rule.selector) && /pointer-events:\s*auto/.test(rule.body)), "toast cards themselves stay clickable");
}

const styles = read("src/styles.css");
assert.doesNotMatch(styles, /cv-notification/, "the old global notification skin is gone");
for (const tone of ["info", "success", "warning", "danger"]) {
  assert.match(styles, new RegExp(`--cv-icon-${tone}:`), `--cv-icon-${tone} token`);
}
const dialogCss = read("src/components/AppDialog.module.css");
assert.match(dialogCss, /\.titleIcon\[data-tone="danger"\] \{ color: var\(--cv-icon-danger\); \}/, "AppDialog shares the icon tokens");

const main = read("src/main.tsx");
assert.match(main, /<Notifications\s+position="top-right"\s+autoClose=\{TOAST_AUTO_CLOSE_MS\}\s+limit=\{TOAST_LIMIT\}\s+containerWidth=\{TOAST_WIDTH\}\s+classNames=\{toastContainerClassNames\}\s+\/>/);
assert.equal(TOAST_LIMIT, 3, "at most three stacked toasts in the 820×560 window");

assert.match(read("src/hooks/useRuntimeActions.ts"), /tone: guidance\.tone,/, "guidance tones map one-to-one");
assert.match(read("src/hooks/useUpdateFlow.ts"), /tone: result\.forceUpgrade \? "danger" : "info"/);
assert.match(read("src/App.tsx"), /showToast\(\{message:"旧下载镜像已清除，请重新下载。",tone:"success"\}\)/, "teal maps to success");

console.log("toast tones, error code line, deduplication and single showToast entry passed");
