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
  const api = read(join(desktopRoot, "src", "api", "client.ts"));

  assert.match(app, /<RoutingRulesModal[\s\S]*accessToken=\{session\.accessToken\}/);
  assert.match(app, /onOpenRoutingRules=\{\(\) => setRoutingRulesOpened\(true\)\}/);
  assert.match(controlPanel, /onOpenRoutingRules: \(\) => void/);
  assert.match(controlPanel, /IconRoute/);
  assert.match(api, /\/client\/routing-rules\/test/);
  assert.match(api, /\/client\/routing-rules/);
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
testSharedRuntimeDtoCarriesRules();
