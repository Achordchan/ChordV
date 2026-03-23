import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.resolve(root, ".deploy", "chordv-1panel-bundle");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copyTargets = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/src",
  "apps/api/prisma",
  "packages/shared/package.json",
  "packages/shared/tsconfig.json",
  "packages/shared/src",
  "apps/admin/dist",
  "deploy/1panel/chordv/Dockerfile.api",
  "deploy/1panel/chordv/docker-compose.yml",
  "deploy/1panel/chordv/openresty.v.baymaxgroup.com.conf"
];

for (const target of copyTargets) {
  const source = path.resolve(root, target);
  if (!existsSync(source)) {
    throw new Error(`缺少部署文件：${target}`);
  }

  const destination = path.resolve(outDir, target);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

writeFileSync(
  path.resolve(outDir, "DEPLOY_NOTE.txt"),
  [
    "这个目录用于 1Panel 新服务器部署 ChordV。",
    "admin-dist 已经是本地构建好的静态文件。",
    "API 通过 Docker 启动，Postgres 通过 Docker 持久化。",
    "上线前请写入 .env，并确认 v.baymaxgroup.com 的 DNS 切换时机。"
  ].join("\n"),
  "utf8"
);

console.log(outDir);
