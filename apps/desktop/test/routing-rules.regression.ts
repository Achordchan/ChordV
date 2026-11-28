import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  const api = read(join(desktopRoot, "src", "api", "connection.ts"));

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

function testGoRoutingRuleInjectionOrder() {
  const native = read(join(desktopRoot, "native", "runtime_config.go"));
  const diagnostics = read(join(desktopRoot, "native", "routing_diagnostics.go"));
  assert.ok(native.indexOf("range config.CustomRoutingRules") < native.indexOf('"geoip:private"'), "custom rules precede built-in rules");
  assert.match(native, /rule\.MatchType \+ ":" \+ strings\.TrimSpace\(rule\.Value\)/);
  assert.match(native, /!rule\.Enabled/);
  assert.match(native, /"access": logPath/);
  assert.match(diagnostics, /func \(s \*DesktopService\) testRoutingRule/);
  assert.match(diagnostics, /queryGeosite/);
  assert.doesNotMatch(diagnostics, /test_routing_rule_egress|parse_routing_egress_log/);
  const realTests = read(join(desktopRoot, "native", "runtime_test.go"));
  assert.match(realTests, /TestRuntimeConfigPreservesOrderedRulesAndRealityFields/);
}

function testDesktopInstallersShipWithoutRuntimeComponents() {
  const packageJson = read(join(desktopRoot, "package.json"));
  const buildScript = read(join(repoRoot, "scripts", "mygo-desktop.mjs"));
  const runtimeAssets = read(join(desktopRoot, "src", "hooks", "useRuntimeAssets.ts"));
  const components = read(join(desktopRoot, "native", "components.go"));
  assert.doesNotMatch(packageJson, /tauri:|@tauri-apps/);
  assert.match(buildScript, /const buildArgs = \["tool", "mygo", "build"/);
  assert.match(buildScript, /await run\("go", buildArgs(?:,|\))/);
  assert.doesNotMatch(buildScript, /setup-xray|bin\/xray|bin\/geo(ip|site)\.dat/);
  const resources = readdirSync(join(desktopRoot, "native", "resources"), { recursive: true }).map(String);
  assert.ok(resources.every(file => !/(?:^|[\\/])(?:xray(?:\.exe)?|geoip\.dat|geosite\.dat)$/i.test(file)), "installers must not embed runtime components");
  assert.match(components, /"copiedComponents": \[\]string\{\}/);
  assert.match(runtimeAssets, /fetchGitHubRuntimeComponentsPlan/);
  assert.match(runtimeAssets, /if \(inspectOnly\) \{[\s\S]{0,400}if \(!localReady\) \{\s*markPendingInstall\(\);\s*return true;/);
}

function testSharedRuntimeDtoCarriesRules() {
  const sharedTypes = read(join(repoRoot, "packages", "shared", "src", "types.ts"));
  const sharedIndex = read(join(repoRoot, "packages", "shared", "src", "index.ts"));
  assert.match(sharedTypes, /interface ClientRoutingRuleDto/);
  assert.match(sharedTypes, /customRoutingRules: ClientRoutingRuleDto\[\]/);
  assert.doesNotMatch(sharedIndex, /export.*mock/, "production shared package must not export fake business data");
}

testDesktopRoutingRuleEntryAndApi();
testGoRoutingRuleInjectionOrder();
testDesktopInstallersShipWithoutRuntimeComponents();
testSharedRuntimeDtoCarriesRules();
