import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePrimaryFillPhase, shouldCompleteFill, shouldReleaseFill } from "../src/lib/primaryActionFill.ts";
import { describeRequiredUpdate } from "../src/lib/updateState.ts";

const styles = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const controlPanel = readFileSync(resolve(import.meta.dirname, "../src/components/ControlPanel.tsx"), "utf8");
const app = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

// Connect button fill phases follow the runtime, not a fake percentage.
assert.equal(resolvePrimaryFillPhase("idle", "connect"), "connecting");
assert.equal(resolvePrimaryFillPhase("connecting", "connect"), "connecting");
assert.equal(resolvePrimaryFillPhase("connected", "connect"), "idle");
assert.equal(resolvePrimaryFillPhase("connected", null), "idle");
assert.equal(resolvePrimaryFillPhase("disconnecting", "disconnect"), "disconnecting");
assert.equal(resolvePrimaryFillPhase("idle", "disconnect"), "disconnecting");
assert.equal(resolvePrimaryFillPhase("idle", null), "idle");
assert.equal(shouldCompleteFill("connecting", "idle", "connected"), true);
assert.equal(shouldCompleteFill("connecting", "idle", "error"), false);
assert.equal(shouldCompleteFill("connecting", "idle", "idle"), false);
assert.equal(shouldCompleteFill("disconnecting", "idle", "idle"), false);
// A disconnect that really ended idle sweeps the remaining bar away; a failed stop, a connect, or no change does not.
assert.equal(shouldReleaseFill("disconnecting", "idle", "idle"), true);
assert.equal(shouldReleaseFill("disconnecting", "idle", "error"), false);
assert.equal(shouldReleaseFill("disconnecting", "idle", "connected"), false);
assert.equal(shouldReleaseFill("connecting", "idle", "idle"), false);
assert.equal(shouldReleaseFill("idle", "idle", "idle"), false);
// transform-only animation, completion sweep, and a reduced-motion fallback.
assert.match(styles, /@keyframes cv-connect-fill \{\s*from \{ transform: scaleX\([\d.]+\); \}\s*to \{ transform: scaleX\(0\.9\d?\); \}/);
assert.match(styles, /\[data-fill="completing"\]::before \{\s*animation: cv-connect-complete/);
assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.control-primary-action\[data-fill\]/);
assert.match(controlPanel, /aria-busy=/);
assert.doesNotMatch(controlPanel, /loading=\{props\.primaryBusy\}/);
console.log("connect button progress fill checks passed");

// A locked (disabled) SegmentedControl loses data-active on the label; the
// selected label must still be readable and never white-on-cyan.
assert.doesNotMatch(controlPanel, /control-panel__mode-switch"\s*color=/);
assert.match(styles, /\.mantine-SegmentedControl-control\[data-active\] \.mantine-SegmentedControl-label \{\s*font-weight: 600;\s*color: var\(--cv-text\);/);
assert.doesNotMatch(styles, /SegmentedControl-label\[data-active\] \{[^}]*color: #fff/);
console.log("mode switch contrast checks passed");

// Forced releases may keep minimumVersion at 0.0.0.
assert.equal(
  describeRequiredUpdate({ latestVersion: "1.1.9", minimumVersion: "0.0.0" }, "1.1.8"),
  "这是一次必要更新，请更新到 1.1.9 后继续使用。"
);
assert.match(describeRequiredUpdate({ latestVersion: "1.1.9", minimumVersion: "1.1.9" }, "1.1.8"), /1\.1\.8 已低于最低支持版本/);
// The fixed-size desktop layout carries no inline update banner.
const desktopMain = app.slice(app.indexOf('<div className="desktop-main">'), app.indexOf('<div className="desktop-content">'));
assert.doesNotMatch(desktopMain, /forceUpdate(Banner|Notice)\}/);
assert.doesNotMatch(app, /已低于最低支持版本，请先升级到/);
console.log("required update notice checks passed");
