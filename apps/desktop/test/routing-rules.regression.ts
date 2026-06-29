import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const desktopRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..", "..");

function read(path: string) {
  return readFileSync(path, "utf8");
}

function testDesktopRoutingRuleEntryAndApi() {
  const app = read(join(desktopRoot, "src", "App.tsx"));
  const controlPanel = read(join(desktopRoot, "src", "components", "ControlPanel.tsx"));
  const modal = read(join(desktopRoot, "src", "components", "RoutingRulesModal.tsx"));
  const api = read(join(desktopRoot, "src", "api", "client.ts"));

  assert.match(app, /<RoutingRulesModal[\s\S]*accessToken=\{session\.accessToken\}/);
  assert.match(app, /mode=\{mode\}/);
  assert.match(app, /policies=\{bootstrap\.policies\}/);
  assert.match(app, /onOpenRoutingRules=\{\(\) => setRoutingRulesOpened\(true\)\}/);
  assert.match(controlPanel, /onOpenRoutingRules: \(\) => void/);
  assert.match(controlPanel, /IconRoute/);
  assert.doesNotMatch(api, /\/client\/routing-rules\/test/);
  assert.doesNotMatch(api, /test_routing_rule_egress/);
  assert.match(api, /\/client\/routing-rules/);
  assert.match(api, /test_routing_rule/);
  assert.doesNotMatch(modal, /function testRoutingRuleLocally/);
  assert.doesNotMatch(modal, /fetch\(/);
  assert.match(controlPanel, /自定义分流[\s\S]*连接诊断/);
  assert.doesNotMatch(controlPanel, /<Group wrap="nowrap" align="stretch">[\s\S]*onOpenRoutingRules/);
}

function testRustRoutingRuleInjectionOrder() {
  const rust = read(join(desktopRoot, "src-tauri", "src", "lib.rs"));
  const customRulesIndex = rust.indexOf("custom_routing_rules: Vec<ClientRoutingRuleDto>");
  const routingCallIndex = rust.indexOf("routing_rules(config.mode.as_str(), &config.features, &config.custom_routing_rules)");
  const collectIndex = rust.indexOf(".filter(|rule| rule.enabled");
  const privateRuleIndex = rust.indexOf("\"ip\": [\"geoip:private\"]");

  assert.notEqual(customRulesIndex, -1);
  assert.notEqual(routingCallIndex, -1);
  assert.ok(collectIndex > -1 && privateRuleIndex > collectIndex, "custom rules must be inserted before built-in rules");
  assert.match(rust, /format!\("domain:\{value\}"\)/);
  assert.match(rust, /format!\("keyword:\{value\}"\)/);
  assert.match(rust, /fn test_routing_rule/);
  assert.match(rust, /query_geosite_routing/);
  assert.match(rust, /"access": log_path\.to_string_lossy\(\)\.to_string\(\)/);
  assert.doesNotMatch(rust, /test_routing_rule_egress/);
  assert.doesNotMatch(rust, /parse_routing_egress_log/);
}

function testWindowsInstallerCleansStaleRuntime() {
  const config = read(join(desktopRoot, "src-tauri", "tauri.conf.json"));
  const hook = read(join(desktopRoot, "src-tauri", "windows", "chordv-installer-hooks.nsh"));

  assert.match(config, /"installerHooks": "windows\/chordv-installer-hooks\.nsh"/);
  assert.match(hook, /NSIS_HOOK_PREINSTALL/);
  assert.match(hook, /Get-Process chordv-desktop,ChordV/);
  assert.match(hook, /app\.chordv\.desktop\*runtime\*bin\*xray\.exe/);
  assert.match(hook, /127\.0\.0\.1:17890/);
}

function testMacosUniversalBundleCarriesBothRuntimeBinaries() {
  const packageJson = read(join(desktopRoot, "package.json"));
  const buildScript = read(join(desktopRoot, "scripts", "build-tauri-platform.mjs"));
  const checkScript = read(join(desktopRoot, "scripts", "check-macos-bundle.mjs"));

  assert.match(packageJson, /"check:macos-bundle": "node \.\/scripts\/check-macos-bundle\.mjs"/);
  assert.match(buildScript, /\["darwin-arm64", "darwin-x64"\]/);
  assert.match(buildScript, /"bin\/xray-aarch64-apple-darwin"/);
  assert.match(buildScript, /"bin\/xray-x86_64-apple-darwin"/);
  assert.match(checkScript, /xray-aarch64-apple-darwin/);
  assert.match(checkScript, /xray-x86_64-apple-darwin/);
}

function testSharedRuntimeDtoCarriesRules() {
  const sharedTypes = read(join(repoRoot, "packages", "shared", "src", "types.ts"));
  const sharedMock = read(join(repoRoot, "packages", "shared", "src", "mock.ts"));

  assert.match(sharedTypes, /interface ClientRoutingRuleDto/);
  assert.match(sharedTypes, /customRoutingRules: ClientRoutingRuleDto\[\]/);
  assert.match(sharedMock, /customRoutingRules: \[\]/);
}

testDesktopRoutingRuleEntryAndApi();
testRustRoutingRuleInjectionOrder();
testWindowsInstallerCleansStaleRuntime();
testMacosUniversalBundleCarriesBothRuntimeBinaries();
testSharedRuntimeDtoCarriesRules();
