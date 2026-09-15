import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const api = resolve(root, "apps/api");
const direct = [
  ["test/panel-inbound.regression.ts", true], ["../admin/test/panel-inbound.regression.ts", true],
  ["test/agent-api.regression.ts", false], ["test/agent-register.regression.ts", false],
  ["test/agent-two-stage.regression.ts", true], ["test/agent-install-staging.regression.ts", true],
  ["test/agent-inbound.regression.ts", true], ["test/runtime-session.regression.ts", true],
  ["test/agent-onboarding-safety.regression.ts", true], ["test/agent-reliability.regression.ts", false],
  ["test/direct-metering-migration.regression.ts", false], ["../desktop/test/agent-runtime-contract.regression.ts", false],
  ["../admin/test/agent-node-onboarding.regression.ts", false], ["../admin/test/inbound-deploy.regression.ts", true]
];
function run(args, cwd = api) {
  return new Promise((yes, no) => { const child = spawn(args[0], args.slice(1), { cwd, stdio: "inherit", env: process.env }); child.once("error", no); child.once("exit", code => code === 0 ? yes() : no(new Error(`${args.join(" ")} failed (${code})`))); });
}
await run(["npm", "run", "build"], resolve(root, "packages/shared"));
const tsx = resolve(api, "node_modules/.bin/tsx");
const directTasks = direct.map(([file, strict]) => {
  const cwd = file.startsWith("../admin/") ? resolve(root, "apps/admin") : file.startsWith("../desktop/") ? resolve(root, "apps/desktop") : api;
  return run([tsx, ...(strict ? ["--tsconfig", cwd === api ? "tsconfig.json" : "tsconfig.json"] : []), file.replace(/^\.\.\/(?:admin|desktop)\//, "")], cwd);
});
const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(api, "package.json"), "utf8"));
const regressionTasks = packageJson.scripts["test:regression"].split(" && ").slice(1).map(command => {
  const args = command.split(" ");
  if (args[0] === "tsx") args[0] = tsx;
  const cwd = args.some(value => value.startsWith("../admin/")) ? resolve(root, "apps/admin") : args.some(value => value.startsWith("../desktop/")) ? resolve(root, "apps/desktop") : api;
  if (cwd !== api) { const index = args.indexOf("../admin/tsconfig.json"); if (index >= 0) args[index] = "tsconfig.json"; for (let i = 0; i < args.length; i++) args[i] = args[i].replace(/^(?:\.\.\/admin|\.\.\/desktop)\//, ""); }
  return run(args, cwd);
});
const results = await Promise.allSettled([...regressionTasks, ...directTasks]);
const failures = results.filter(result => result.status === "rejected");
if (failures.length) throw new AggregateError(failures.map(result => result.reason), `${failures.length} API verification commands failed`);
console.log(`API release verification passed (${results.length} test commands)`);
