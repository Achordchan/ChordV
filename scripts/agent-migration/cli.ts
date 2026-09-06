import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareRestartAwareShadowUsage, compareShadowUsage, reconcileNodeUsers } from "./index.ts";
import type { BindingRecord, RemoteUserRecord, ShadowCounterSample, ShadowThresholds, ShadowUsageDelta } from "./types.ts";

type Arguments = Record<string, string>;

function parseArguments(values: string[]) {
  const command = values[0];
  const argumentsMap: Arguments = {};
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`无效参数：${key ?? "<empty>"}`);
    argumentsMap[key.slice(2)] = value;
  }
  return { command, argumentsMap };
}

async function readJson<T>(path: string | undefined, label: string): Promise<T> {
  if (!path) throw new Error(`缺少 --${label}`);
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

async function emitReport(report: unknown, outputPath?: string) {
  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await writeFile(resolve(outputPath), content, { encoding: "utf8", flag: "wx" });
    return;
  }
  process.stdout.write(content);
}

async function main() {
  const { command, argumentsMap } = parseArguments(process.argv.slice(2));
  if (command === "reconcile") {
    const [bindings, xuiUsers, xrayUsers] = await Promise.all([
      readJson<BindingRecord[]>(argumentsMap.bindings, "bindings"),
      readJson<RemoteUserRecord[]>(argumentsMap.xui, "xui"),
      readJson<RemoteUserRecord[]>(argumentsMap.xray, "xray")
    ]);
    await emitReport(reconcileNodeUsers({ bindings, xuiUsers, xrayUsers }), argumentsMap.out);
    return;
  }
  if (command === "shadow") {
    const [xui, direct] = await Promise.all([
      readJson<ShadowUsageDelta[]>(argumentsMap.xui, "xui"),
      readJson<ShadowUsageDelta[]>(argumentsMap.direct, "direct")
    ]);
    const thresholds: ShadowThresholds = {
      absoluteBytes: argumentsMap["absolute-bytes"] ?? "1048576",
      relativePercent: Number(argumentsMap["relative-percent"] ?? "0.1")
    };
    await emitReport(compareShadowUsage(xui, direct, thresholds), argumentsMap.out);
    return;
  }
  if (command === "shadow-series") {
    const [xui, direct] = await Promise.all([
      readJson<ShadowCounterSample[]>(argumentsMap.xui, "xui"),
      readJson<ShadowCounterSample[]>(argumentsMap.direct, "direct")
    ]);
    const thresholds: ShadowThresholds = {
      absoluteBytes: argumentsMap["absolute-bytes"] ?? "1048576",
      relativePercent: Number(argumentsMap["relative-percent"] ?? "0.1")
    };
    const minimumSteadyWindows = Number(argumentsMap["minimum-steady-windows"] ?? "1");
    await emitReport(compareRestartAwareShadowUsage(xui, direct, thresholds, minimumSteadyWindows), argumentsMap.out);
    return;
  }
  throw new Error("用法：tsx cli.ts reconcile --bindings bindings.json --xui xui.json --xray xray.json [--out report.json]；shadow --xui xui-delta.json --direct direct-delta.json；或 shadow-series --xui xui-samples.json --direct direct-samples.json [--minimum-steady-windows 1]");
}

main().catch((error) => {
  process.stderr.write(`迁移核对失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
