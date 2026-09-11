#!/usr/bin/env bash

runtime_root="$(pwd)/.data/local-runtime"
postgres_version="16.14-2"
postgres_archive_sha256="8a7f54c1968d5d49bdcd3f66b1291f736c74b8cb6a26e9874771fcc7837dbf38"
postgres_archive_url="https://get.enterprisedb.com/postgresql/postgresql-16.14-2-windows-x64-binaries.zip"
postgres_install_dir="$runtime_root/postgresql-$postgres_version"
postgres_data_dir="$runtime_root/postgres-data"
postgres_log_file="$runtime_root/postgres.log"
managed_postgres_started=false
managed_local_database=false
dev_credentials_created=false
dev_admin_password_file="$runtime_root/dev-admin-password"
dev_jwt_secret_file="$runtime_root/dev-jwt-secret"

runtime_fail() {
  if declare -F fail >/dev/null 2>&1; then
    fail "$1"
  fi
  printf '启动失败：%s\n' "$1" >&2
  exit 1
}

is_windows_bash() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

to_posix_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s\n' "$1"
  fi
}

to_windows_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

ensure_windows_pnpm_shim() {
  is_windows_bash || return 0
  mkdir -p "$runtime_root/bin"
  printf '@echo off\r\ncorepack pnpm %%*\r\n' > "$runtime_root/bin/pnpm.cmd"
  export PATH="$runtime_root/bin:$PATH"
  hash -r
}

select_node_runtime() {
  # Local development uses the caller's Node runtime. .nvmrc remains the CI
  # baseline, not a restriction or an automatic version switch on this machine.
  command -v node >/dev/null 2>&1 || runtime_fail "未找到 Node.js，请先安装并加入 PATH"
  actual_node=$(node --version) || runtime_fail "当前 Node.js 无法执行"
  ensure_windows_pnpm_shim
  printf '使用当前 Node.js %s。\n' "${actual_node#v}"
}

ensure_local_corepack() {
  command -v corepack >/dev/null 2>&1 && return 0

  # Keep the launcher local and versioned. Newer Node distributions may omit
  # Corepack; installing it here must not modify global npm or Node files.
  local corepack_version="0.34.5"
  local tooling_dir="$runtime_root/tooling/corepack-$corepack_version"
  if [ ! -f "$tooling_dir/node_modules/corepack/dist/corepack.js" ] ||
    [ ! -f "$tooling_dir/node_modules/.bin/corepack" ] ||
    { is_windows_bash && [ ! -f "$tooling_dir/node_modules/.bin/corepack.cmd" ]; }; then
    command -v npm >/dev/null 2>&1 || runtime_fail "未找到 Corepack 或 npm，请安装带 npm 的 Node.js 后重试"
    mkdir -p "$tooling_dir"
    printf '首次运行：正在项目目录准备 Corepack %s。\n' "$corepack_version"
    npm install --prefix "$tooling_dir" --no-save --package-lock=false --no-audit --no-fund "corepack@$corepack_version" ||
      runtime_fail "项目本地 Corepack 安装失败，请检查 npm 网络连接后重试"
  fi
  export PATH="$tooling_dir/node_modules/.bin:$PATH"
  hash -r
  command -v corepack >/dev/null 2>&1 || runtime_fail "项目本地 Corepack 不可用，请检查 .data/local-runtime/tooling 目录"
}

ensure_pnpm_and_dependencies() {
  ensure_local_corepack
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  required_pnpm=$(node -p "(require('./package.json').packageManager || '').split('@')[1] || ''")
  actual_pnpm=$(corepack pnpm --version) || runtime_fail "pnpm 不可用"
  if [ -n "$required_pnpm" ] && [ "$actual_pnpm" != "$required_pnpm" ]; then
    runtime_fail "pnpm 版本为 $actual_pnpm，项目要求 $required_pnpm"
  fi

  if [ ! -f node_modules/.modules.yaml ]; then
    printf '首次运行：正在安装项目依赖。\n'
    corepack pnpm install --frozen-lockfile || runtime_fail "依赖安装失败"
  fi
}

ensure_prisma_client() {
  # Compare the generated client with the actual schema instead of regenerating
  # unchanged files on every startup. This reads files only, not the database.
  if node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
try {
  const clientPackage = require.resolve("@prisma/client/package.json", { paths: [path.resolve("apps/api")] });
  const generated = require.resolve(".prisma/client/default", { paths: [path.dirname(clientPackage)] });
  const schema = path.join(path.dirname(generated), "schema.prisma");
  const sameSchema = fs.readFileSync(schema).equals(fs.readFileSync("apps/api/prisma/schema.prisma"));
  const generatedVersion = require(generated).Prisma.prismaVersion.client;
  process.exit(sameSchema && generatedVersion === require(clientPackage).version ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    printf '复用已生成的 Prisma Client。\n'
  else
    printf '正在生成 Prisma Client。\n'
    corepack pnpm --filter @chordv/api db:generate || runtime_fail "Prisma Client 生成失败"
  fi
}

database_is_available() {
  node <<'NODE'
const net = require("node:net");
let target;
try {
  const url = new URL(process.env.DATABASE_URL);
  target = { host: url.hostname, port: Number(url.port || 5432) };
} catch {
  process.exit(1);
}
const socket = net.createConnection(target);
socket.setTimeout(1200);
socket.once("connect", () => socket.end(() => process.exit(0)));
socket.once("timeout", () => {
  socket.destroy();
  process.exit(1);
});
socket.once("error", () => process.exit(1));
NODE
}

database_url_is_managed_local() {
  node <<'NODE'
try {
  const url = new URL(process.env.DATABASE_URL);
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 5432);
  const database = url.pathname.replace(/^\/+/, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  process.exit(local && port === 54329 && database === "chordv" && url.username === "chordv" ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

verify_sha256() {
  file=$1
  expected=$2
  node - "$file" "$expected" <<'NODE'
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const [file, expected] = process.argv.slice(2);
const hash = createHash("sha256");
createReadStream(file)
  .on("data", (chunk) => hash.update(chunk))
  .on("error", () => process.exit(1))
  .on("end", () => process.exit(hash.digest("hex").toLowerCase() === expected.toLowerCase() ? 0 : 1));
NODE
}

ensure_embedded_postgres() {
  is_windows_bash || runtime_fail "未检测到 Docker 或可用 PostgreSQL；当前自动准备仅支持 Windows Git Bash"
  mkdir -p "$runtime_root/downloads"

  archive="$runtime_root/downloads/postgresql-$postgres_version-windows-x64-binaries.zip"
  archive_part="$archive.part"
  if [ -f "$archive" ] && ! verify_sha256 "$archive" "$postgres_archive_sha256"; then
    rm -f "$archive"
  fi

  if [ ! -f "$archive" ]; then
    command -v curl.exe >/dev/null 2>&1 || runtime_fail "未找到 curl.exe，无法下载项目本地 PostgreSQL"
    printf '首次运行：正在下载 PostgreSQL %s（约 311 MiB）。\n' "$postgres_version"
    rm -f "$archive_part"
    curl.exe --fail --location --progress-bar --output "$(to_windows_path "$archive_part")" "$postgres_archive_url" || runtime_fail "PostgreSQL 下载失败"
    verify_sha256 "$archive_part" "$postgres_archive_sha256" || runtime_fail "PostgreSQL ZIP 校验失败"
    mv "$archive_part" "$archive"
  fi

  if [ ! -x "$postgres_install_dir/bin/postgres.exe" ]; then
    extract_dir="$postgres_install_dir.part"
    rm -rf "$extract_dir"
    mkdir -p "$extract_dir"
    printf '首次运行：正在解压项目本地 PostgreSQL。\n'
    archive_windows=$(to_windows_path "$archive")
    extract_windows=$(to_windows_path "$extract_dir")
    POSTGRES_ARCHIVE_PATH="$archive_windows" POSTGRES_EXTRACT_PATH="$extract_windows" \
      powershell.exe -NoProfile -NonInteractive -Command 'Expand-Archive -LiteralPath $env:POSTGRES_ARCHIVE_PATH -DestinationPath $env:POSTGRES_EXTRACT_PATH -Force' || runtime_fail "PostgreSQL ZIP 解压失败"
    [ -x "$extract_dir/pgsql/bin/postgres.exe" ] || runtime_fail "PostgreSQL 解压结果不完整"
    mv "$extract_dir/pgsql" "$postgres_install_dir"
    rm -rf "$extract_dir"
  fi
}

initialize_embedded_postgres() {
  pg_bin="$postgres_install_dir/bin"
  mkdir -p "$runtime_root"
  if [ ! -f "$postgres_data_dir/PG_VERSION" ]; then
    password_file="$runtime_root/postgres-password.tmp"
    printf 'chordv\n' > "$password_file"
    "$pg_bin/initdb.exe" \
      -D "$(to_windows_path "$postgres_data_dir")" \
      -U chordv \
      --pwfile="$(to_windows_path "$password_file")" \
      --encoding=UTF8 \
      --locale=C \
      --auth-host=scram-sha-256 \
      --auth-local=trust || runtime_fail "PostgreSQL 数据目录初始化失败"
    rm -f "$password_file"
  fi
}

start_embedded_postgres() {
  ensure_embedded_postgres
  initialize_embedded_postgres
  pg_bin="$postgres_install_dir/bin"
  printf '正在启动项目本地 PostgreSQL：http://127.0.0.1:54329\n'
  "$pg_bin/pg_ctl.exe" \
    -D "$(to_windows_path "$postgres_data_dir")" \
    -l "$(to_windows_path "$postgres_log_file")" \
    -o "-h 127.0.0.1 -p 54329" \
    -w -t 30 start || runtime_fail "PostgreSQL 启动失败，请查看 $postgres_log_file"
  managed_postgres_started=true
}

ensure_local_database_exists() {
  [ -x "$postgres_install_dir/bin/psql.exe" ] || return 0
  export PGPASSWORD=chordv
  exists=$("$postgres_install_dir/bin/psql.exe" -h 127.0.0.1 -p 54329 -U chordv -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='chordv'" | tr -d '[:space:]')
  if [ "$exists" != "1" ]; then
    "$postgres_install_dir/bin/createdb.exe" -h 127.0.0.1 -p 54329 -U chordv chordv || runtime_fail "创建 chordv 数据库失败"
  fi
  unset PGPASSWORD
}

read_or_create_secret() {
  target=$1
  bytes=$2
  if [ ! -s "$target" ]; then
    mkdir -p "$runtime_root"
    node -e "process.stdout.write(require('node:crypto').randomBytes(Number(process.argv[1])).toString('base64url'))" "$bytes" > "$target.tmp"
    mv "$target.tmp" "$target"
    chmod 600 "$target" 2>/dev/null || true
    dev_credentials_created=true
  fi
  tr -d '\r\n' < "$target"
}

ensure_local_dev_secrets() {
  if [ -z "${CHORDV_DEV_ADMIN_PASSWORD:-}" ]; then
    if [ ! -s "$dev_admin_password_file" ]; then
      dev_credentials_created=true
    fi
    CHORDV_DEV_ADMIN_PASSWORD=$(read_or_create_secret "$dev_admin_password_file" 18)
    export CHORDV_DEV_ADMIN_PASSWORD
  fi
  if [ -z "${CHORDV_JWT_SECRET:-}" ]; then
    CHORDV_JWT_SECRET=$(read_or_create_secret "$dev_jwt_secret_file" 32)
    export CHORDV_JWT_SECRET
  fi
}

prepare_local_database() {
  if [ -z "${DATABASE_URL:-}" ]; then
    export DATABASE_URL="postgresql://chordv:chordv@127.0.0.1:54329/chordv?schema=public"
    managed_local_database=true
  elif database_url_is_managed_local; then
    managed_local_database=true
  fi

  if ! database_is_available; then
    if [ "$managed_local_database" != true ]; then
      runtime_fail "配置的 PostgreSQL 不可用；脚本不会替换或修改远程数据库配置"
    fi
    start_embedded_postgres
  fi

  if [ "$managed_local_database" = true ]; then
    ensure_local_dev_secrets
    ensure_local_database_exists
    printf '正在同步本地数据库结构。\n'
    corepack pnpm --filter @chordv/api db:migrate:baseline-deploy || runtime_fail "本地数据库迁移失败"

    seed_marker="$postgres_data_dir/.chordv-seeded"
    seed_version="2"
    current_seed_version=""
    if [ -f "$seed_marker" ]; then
      current_seed_version=$(tr -d '\r\n' < "$seed_marker")
    fi
    if [ "$current_seed_version" != "$seed_version" ] || [ "$dev_credentials_created" = true ]; then
      printf '正在同步本地开发数据。\n'
      NODE_ENV=development CHORDV_DEV_SEED_CONFIRM=true corepack pnpm --filter @chordv/api db:seed || runtime_fail "本地开发数据初始化失败"
      mkdir -p "$postgres_data_dir"
      printf '%s\n' "$seed_version" > "$seed_marker"
    fi
    printf '本地管理员账号：admin\n'
    printf '本地管理员密码：%s\n' "$CHORDV_DEV_ADMIN_PASSWORD"
  fi
}

cleanup_local_runtime() {
  status=$?
  trap - EXIT INT TERM
  if [ "$managed_postgres_started" = true ] && [ -x "$postgres_install_dir/bin/pg_ctl.exe" ]; then
    printf '\n正在停止项目本地 PostgreSQL。\n'
    "$postgres_install_dir/bin/pg_ctl.exe" -D "$(to_windows_path "$postgres_data_dir")" -m fast -w -t 20 stop >/dev/null 2>&1 || true
  fi
  exit "$status"
}

install_local_runtime_cleanup() {
  trap cleanup_local_runtime EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
