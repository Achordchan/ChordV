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
  // Backend system version + the migration helper the api Dockerfile/entrypoint use.
  "SYSTEM_VERSION",
  "scripts/prisma-migrate-with-baseline.mjs",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/src",
  "apps/api/prisma",
  "packages/shared/package.json",
  "packages/shared/tsconfig.json",
  "packages/shared/scripts",
  "packages/shared/src",
  // admin is built from source inside the image now (one release unit), so ship
  // its build inputs rather than a pre-built dist.
  "apps/admin/package.json",
  "apps/admin/tsconfig.json",
  "apps/admin/vite.config.ts",
  "apps/admin/index.html",
  "apps/admin/src",
  "deploy/1panel/chordv/Dockerfile.api",
  "deploy/1panel/chordv/Dockerfile.admin",
  "deploy/1panel/chordv/docker-compose.yml",
  "deploy/1panel/chordv/entrypoint.sh",
  "deploy/1panel/chordv/admin-entrypoint.sh",
  "deploy/1panel/chordv/admin.nginx.conf",
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
    "这个目录用于 1Panel 新服务器部署 ChordV（后台系统 = api + admin，一个发布单元）。",
    "api 与 admin 均由 Docker 构建；admin 静态产物在镜像内构建，随 api 自更新自动跟随。",
    "在仓库根执行：docker compose -f deploy/1panel/chordv/docker-compose.yml up -d --build",
    "上线前请写入 .env，并确认 v.baymaxgroup.com 的 DNS / openresty 切换到 admin 容器。"
  ].join("\n"),
  "utf8"
);

console.log(outDir);
