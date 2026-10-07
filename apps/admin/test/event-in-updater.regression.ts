import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// React may run a setState updater after the event handler returns, when
// event.currentTarget is already null. Read the event value before calling the setter.
const srcRoot = resolve(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function testNoEventReadInsideStateUpdater() {
  const updaterReadsEvent = /\bset\w*\(\s*\(?\w+\)?\s*=>[^;]*?\b\w+\.(?:currentTarget|target)\./;
  const offenders = sourceFiles(srcRoot).flatMap(file =>
    readFileSync(file, "utf8").split("\n")
      .map((line, index) => (updaterReadsEvent.test(line) ? `${relative(srcRoot, file)}:${index + 1}` : ""))
      .filter(Boolean)
  );
  assert.deepEqual(offenders, [], `event read inside a setState updater: ${offenders.join(", ")}`);
}

testNoEventReadInsideStateUpdater();

console.log("event-in-updater regression checks passed");
