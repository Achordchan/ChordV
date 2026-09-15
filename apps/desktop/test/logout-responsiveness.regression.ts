import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the real hook with a synchronous hook adapter and a deliberately unresolved remote request.
const source = readFileSync(new URL("../src/hooks/useAuthBootstrap.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports: any = {};
vm.runInNewContext(code, { exports, require: (id: string) => id === "react" ? { useCallback: (fn: unknown) => fn } : {} });
const events: string[] = [];
let finishRemote!: () => void;
const remote = new Promise<void>(resolve => { finishRemote = resolve; });
const options = new Proxy({
  session: { accessToken: "old-token", refreshToken: "old-refresh" }, logoutBusy: false, rememberPassword: false,
  forceStopLocalRuntime: async () => { events.push("stopped"); },
  logoutSession: (token: string, refresh: string) => { assert.equal(token, "old-token"); assert.equal(refresh, "old-refresh"); events.push("revoke-started"); return remote; },
  clearStoredSession: async () => { events.push("credentials-cleared"); },
  setSession: (session: unknown) => { assert.equal(session, null); events.push("signed-out"); },
  setLogoutBusy: (busy: boolean) => { events.push(busy ? "busy" : "idle"); }
} as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : () => undefined });
const { handleLogout } = exports.useAuthBootstrap(options);
let completed = false;
void handleLogout().then(() => { completed = true; });
for (let turn=0; turn<20; turn++) await Promise.resolve();
assert.equal(completed, true, "remote revocation must not hold the logout UI open");
assert.deepEqual(events, ["busy", "stopped", "revoke-started", "credentials-cleared", "signed-out", "idle"]);
finishRemote();
console.log("logout local cleanup completes without waiting for remote revocation");
