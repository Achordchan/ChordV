import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/pages/ImageBedPage.tsx"), "utf8");

function testInitialConfigLoadRefreshesFileListWhenTokenExists() {
  assert.match(
    source,
    /void loadConfig\(\{ loadFilesAfter: true \}\);/,
    "image bed page should load files after initial config load when a token exists"
  );
}

testInitialConfigLoadRefreshesFileListWhenTokenExists();

console.log("image bed page regression checks passed");
