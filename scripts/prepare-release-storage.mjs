#!/usr/bin/env node

import { mkdir, access, constants, stat } from "node:fs/promises";
import path from "node:path";

const inputRoot = process.argv[2] || process.env.CHORDV_RELEASE_STORAGE_ROOT || path.resolve(process.cwd(), "storage", "releases");
const resolvedRoot = path.resolve(inputRoot);

async function main() {
  await mkdir(resolvedRoot, { recursive: true });
  await access(resolvedRoot, constants.R_OK | constants.W_OK);
  const info = await stat(resolvedRoot);

  console.log("ChordV 发布存储目录已准备完成");
  console.log(`目录：${resolvedRoot}`);
  console.log(`类型：${info.isDirectory() ? "directory" : "unknown"}`);
  console.log("权限：可读可写");
  console.log("");
  console.log("建议同时配置这些环境变量：");
  console.log(`CHORDV_RELEASE_STORAGE_ROOT=${resolvedRoot}`);
  console.log("CHORDV_PUBLIC_BASE_URL=https://你的域名");
  console.log("CHORDV_RELEASE_MAX_UPLOAD_BYTES=1073741824");
}

main().catch((error) => {
  console.error("准备发布存储目录失败");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
