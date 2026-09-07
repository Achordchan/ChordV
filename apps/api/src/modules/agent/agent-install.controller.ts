import { Controller, Headers, HttpCode, Post, Body, Res } from "@nestjs/common";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { AgentRegisterService } from "./agent-register.service";

/**
 * Renders the one-shot VPS install script for an agent-native node. UNAUTHENTICATED
 * by design: `curl | bash` cannot authenticate. The registration token is supplied
 * via the POST BODY, never the URL — access logs and APM capture request paths and
 * query strings, so a token in the URL would outlive the install in log storage
 * and give a log reader a window to race the installer. A spent or expired token
 * still renders a script — its very first action (registering) will fail with a
 * clear message, which beats an opaque 404 for an operator who lost track of
 * which command was which.
 *
 * The agent payload itself is served by the sibling agent-download route, so the
 * VPS only ever needs this single public origin.
 */
class InstallScriptRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  token!: string;
}

@Controller()
export class AgentInstallController {
  constructor(private readonly registerService: AgentRegisterService) {}

  @Post("agent-install/script.sh")
  @HttpCode(200)
  async installScript(
    @Body() body: InstallScriptRequestDto,
    @Headers("x-forwarded-proto") forwardedProto: string | undefined,
    @Headers("host") host: string | undefined,
    @Res() response: Response
  ) {
    const resolved = await this.registerService.resolveTokenNode(body.token).catch(() => null);
    // The origin the script came FROM is the origin the agent talks to (the admin
    // proxy fronts both the SPA and /api on one domain). Behind the openresty
    // terminator the scheme arrives via x-forwarded-proto; when absent (direct
    // plain-HTTP access to the Node listener), fall back to the listener's own
    // scheme instead of assuming HTTPS — the Node listener does no direct TLS.
    const configuredBase = process.env.CHORDV_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
    // The host/forwarded-proto headers are ATTACKER-CONTROLLED. They end up
    // inside a script that an operator runs as root, so only a bare, validated
    // http(s) origin may pass — never raw header text. An explicitly configured
    // but INVALID origin is an error in its own right: falling back to the
    // headers there would reopen exactly the path the configuration closes.
    const derivedBase = configuredBase
      ? normalizeOrigin(configuredBase)
      : normalizeOrigin(host
        ? `${(forwardedProto?.split(",")[0]?.trim() || "http")}://${host.trim()}`
        : "");
    if (!resolved) {
      sendScript(response, renderErrorScript("该安装令牌无效（不存在）。请在后台重新生成安装命令。"));
      return;
    }
    if (!resolved.usable) {
      sendScript(response, renderErrorScript(
        "该安装令牌已失效（已被使用或已过期）。请在后台重新生成安装命令。"
      ));
      return;
    }
    if (!derivedBase) {
      sendScript(response, renderErrorScript(
        "服务器未配置有效的公网访问地址（CHORDV_PUBLIC_BASE_URL 需为 https:// 开头的裸域名或 IP，非本机地址不接受 http）。"
      ));
      return;
    }
    sendScript(response, renderInstallScript({ token: body.token, apiBase: derivedBase }));
  }
}

/**
 * Accepts ONLY a bare `http(s)://host[:port]` origin: no credentials, no path,
 * query or fragment, and a hostname/IP literal made of characters that cannot
 * carry shell syntax. Anything else — including a header holding `$(...)`, a
 * quote or a newline — yields "" so the caller renders the configuration error
 * script instead of executable attacker input.
 *
 * Plain HTTP is accepted for LOOPBACK only, mirroring the agent's own
 * `assertSafeApiBaseUrl` policy. Two reasons: an installer served over remote
 * HTTP would download an executable package over unauthenticated transport
 * (the structural checks verify shape, not authorship), and the installed agent
 * would then refuse that very base URL and never register — after the host was
 * already modified. Returns the normalized origin.
 */
export function normalizeOrigin(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw || raw.length > 253) return "";
  let url: URL;
  try { url = new URL(raw); } catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password || url.search || url.hash) return "";
  if (url.pathname !== "/" && url.pathname !== "") return "";
  // url.host is already parsed/normalized; this rejects anything (e.g. an IPv6
  // literal's brackets aside) that is not a plain hostname/IP plus port.
  if (!/^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(url.host)) return "";
  if (url.port && Number(url.port) > 65535) return "";
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) return "";
  return `${url.protocol}//${url.host}`;
}

/** Encodes a value as a single-quoted shell literal; nothing inside expands. */
function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sendScript(response: Response, body: string) {
  // Express adapter: write through @Res() — returning a WHATWG Response would be
  // JSON-serialized into `{}`.
  response.status(200);
  response.setHeader("content-type", "text/x-shellscript; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function renderErrorScript(message: string) {
  return `#!/usr/bin/env bash
set -euo pipefail
echo "ChordV Agent 安装中止：${message}" >&2
exit 1
`;
}

export function renderInstallScript({ token, apiBase }: { token: string; apiBase: string }) {
  // Defense in depth: the two interpolated values are validated HERE too, so a
  // caller that forgets to check cannot emit a root-executed script carrying
  // shell syntax. Both are then embedded as single-quoted literals.
  const origin = normalizeOrigin(apiBase);
  if (!origin) throw new Error("安装脚本的公网地址无效");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error("安装脚本的注册令牌格式无效");
  return `#!/usr/bin/env bash
# ChordV Node Agent 一键安装（由控制面动态生成，token 单次有效）
set -euo pipefail

# Routes live under the Nest global /api prefix (same origin fronts the admin SPA).
# Both values are server-side validated and emitted as single-quoted literals:
# no expansion or command substitution can happen here.
API_BASE=${shellLiteral(`${origin}/api`)}
REGISTER_TOKEN=${shellLiteral(token)}
INSTALL_DIR="/opt/chordv-node-agent"
ENV_FILE="/etc/chordv/node-agent.env"
SERVICE_USER="chordv-agent"

if [[ "\$(id -u)" -ne 0 ]]; then
  echo "安装失败：请使用 root 运行。" >&2
  exit 1
fi

# A legacy host may hold its identity ONLY in the env file, with no credentials
# file to trigger the agent-side reset guard. Overwriting it here would point a
# new node at the old node's /var/lib state (desired users, command history,
# unsettled usage). Refuse before touching anything and require an explicit
# migration; the agent's own state-library identity check is the backstop.
if [[ -f "\$ENV_FILE" ]] && grep -qE '^[[:space:]]*(CHORDV_AGENT_ID|CHORDV_AGENT_TOKEN|CHORDV_NODE_ID)=' "\$ENV_FILE"; then
  echo "安装失败：\$ENV_FILE 中已存在以环境变量配置的 Agent 身份。" >&2
  echo "如需把本机改接为新节点：停止 chordv-node-agent，归档 /var/lib/chordv-node-agent 与该环境文件后重跑本命令；" >&2
  echo "如只是升级，请保留原身份并改用发布包升级流程，不要使用注册令牌安装命令。" >&2
  exit 1
fi

case "\$(uname -m)" in
  x86_64) ARCH="linux-x64" ;;
  aarch64|arm64) ARCH="linux-arm64" ;;
  *) echo "安装失败：不支持的架构 \$(uname -m)。" >&2; exit 1 ;;
esac

# The bundled native modules (better-sqlite3) and the systemd unit below both
# require a Node 20.19.x runtime at a FIXED path: the service cannot resolve an
# nvm/wrapped interpreter, and 18/22 fail the native ABI. Probe each candidate's
# VERSION before selecting it — a host with an old /usr/bin/node and a valid
# Node 20 under /usr/local/bin must still install.
NODE_BIN=""
if ! command -v runuser >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
  echo "安装失败：缺少 runuser/flock（util-linux），无法验证服务用户的运行环境。" >&2
  exit 1
fi
if ! id "\$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home /var/lib/chordv-node-agent --shell /usr/sbin/nologin "\$SERVICE_USER"
fi
for candidate in /usr/bin/node /usr/local/bin/node; do
  [[ -x "\$candidate" ]] || continue
  candidate="\$(readlink -f "\$candidate" 2>/dev/null || true)"
  case "\$candidate" in /usr/*|/opt/*) ;; *) continue ;; esac
  candidate_version="\$(runuser -u "\$SERVICE_USER" -- "\$candidate" --version 2>/dev/null || true)"
  if [[ "\$candidate_version" =~ ^v20\\.19\\. ]]; then
    NODE_BIN="\$candidate"
    break
  fi
done
if [[ -z "\$NODE_BIN" ]]; then
  echo "安装失败：未找到 Node.js 20.19.x（要求 20.19.x，可用 node --version 检查已安装版本）。请将 Node.js 20.19.x 安装到服务用户可访问的系统目录（/usr/bin 或 /usr/local/bin），不要使用 root 的 nvm 路径。" >&2
  exit 1
fi

echo "==> 下载 ChordV Node Agent (\$ARCH)…"
RELEASES_DIR="\$INSTALL_DIR/releases"
CURRENT_LINK="\$INSTALL_DIR/current"
if [[ -L "\$INSTALL_DIR" || -L "\$RELEASES_DIR" || ( -e "\$CURRENT_LINK" && ! -L "\$CURRENT_LINK" ) ]]; then
  echo "安装失败：安装目录布局异常，已保留现有文件，请人工检查。" >&2
  exit 1
fi
install -d -m 0755 "\$RELEASES_DIR"
exec 9>"\$RELEASES_DIR/.install.lock"
flock -n 9 || { echo "安装失败：已有安装任务正在执行。" >&2; exit 1; }
STAGING_DIR="\$(mktemp -d "\$RELEASES_DIR/.staging.XXXXXX")"
STAGED_PACKAGE="\$STAGING_DIR/package"
ARCHIVE="\$STAGING_DIR/archive.tar.gz"
NEXT_LINK="\$INSTALL_DIR/.current-next.\${STAGING_DIR##*.}"
cleanup_staging() { rm -f "\$NEXT_LINK"; rm -rf "\$STAGING_DIR"; }
trap cleanup_staging EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Never extract over the running package. A failed or truncated transfer only
# affects this private staging tree; previous flat installs remain untouched too.
if ! curl -fsSL --connect-timeout 15 --max-time 600 "\$API_BASE/agent-download/\$ARCH" -o "\$ARCHIVE" ||
   ! tar -tzf "\$ARCHIVE" >/dev/null; then
  echo "安装失败：无法下载或验证 Agent 安装包，现有版本未修改。" >&2
  exit 1
fi
chgrp "\$SERVICE_USER" "\$STAGING_DIR"
chmod 0710 "\$STAGING_DIR"
chmod 0644 "\$ARCHIVE"
install -d -m 0755 -o "\$SERVICE_USER" -g "\$SERVICE_USER" "\$STAGED_PACKAGE"
# Extract without root privileges; archive ownership cannot grant extra access.
runuser -u "\$SERVICE_USER" -- tar --no-same-owner --no-same-permissions -xzf "\$ARCHIVE" -C "\$STAGED_PACKAGE"
chown -hR root:root "\$STAGED_PACKAGE"
chmod -R u+rwX,go+rX "\$STAGED_PACKAGE"
"\$NODE_BIN" - "\$STAGED_PACKAGE" <<'VERIFY_AGENT'
const fs = require('node:fs'), path = require('node:path');
try {
  const root = fs.realpathSync(process.argv[2]);
  for (const name of ['dist/src/main.js', 'package.json', 'node_modules']) {
    const file = fs.realpathSync(path.join(root, name));
    if (!file.startsWith(root + path.sep)) throw new Error();
    const stat = fs.statSync(file);
    if (name === 'node_modules' ? !stat.isDirectory() : !stat.isFile()) throw new Error();
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== '@chordv/node-agent' || typeof metadata.version !== 'string' || !metadata.version.trim()) throw new Error();
} catch {
  console.error('安装失败：Agent 安装包结构无效，现有版本未修改。');
  process.exitCode = 1;
}
VERIFY_AGENT
runuser -u "\$SERVICE_USER" -- "\$NODE_BIN" --check "\$STAGED_PACKAGE/dist/src/main.js"
RELEASE_DIR="\$RELEASES_DIR/release.\${STAGING_DIR##*.}"
[[ ! -e "\$RELEASE_DIR" && ! -L "\$RELEASE_DIR" ]] || exit 1
mv -T "\$STAGED_PACKAGE" "\$RELEASE_DIR"
sync -f "\$RELEASE_DIR"
ln -s "\$RELEASE_DIR" "\$NEXT_LINK"
# GNU rename replaces the link itself, so readers always see a complete release.
mv -fT "\$NEXT_LINK" "\$CURRENT_LINK"
sync -f "\$INSTALL_DIR"

install -d -m 0750 -o "\$SERVICE_USER" -g "\$SERVICE_USER" /var/lib/chordv-node-agent

# Root-owned directory and file: the env file is shell-sourced by
# deploy/health-check.sh, which operators run as root. A service-writable env
# file would turn an agent compromise into root command execution.
install -d -m 0750 -o root -g root /etc/chordv
cat > "\$ENV_FILE" <<EOF
CHORDV_API_BASE_URL=\${API_BASE%/api}
CHORDV_REGISTER_TOKEN=\$REGISTER_TOKEN
AGENT_DATABASE_PATH=/var/lib/chordv-node-agent/agent.db
AGENT_CREDENTIALS_PATH=/var/lib/chordv-node-agent/credentials.json
CHORDV_AGENT_NODE_BIN=\${NODE_BIN@Q}
EOF
# systemd reads EnvironmentFile as root before dropping privileges; the group
# grant only lets the service user read it, never write it.
chown root:"\$SERVICE_USER" "\$ENV_FILE"
chmod 0640 "\$ENV_FILE"

${renderXrayInstall()}
cat > /etc/systemd/system/chordv-node-agent.service <<UNIT
[Unit]
Description=ChordV Node Agent
# Ordering only. Requires= would stop this service whenever xray is stopped —
# and every changed ENSURE_INBOUND restarts xray, which would kill the agent
# mid-command, before it can reconcile users or report the result.
After=network-online.target xray.service
Wants=network-online.target xray.service

[Service]
Type=simple
User=chordv-agent
Group=chordv-agent
WorkingDirectory=/opt/chordv-node-agent/current
EnvironmentFile=/etc/chordv/node-agent.env
ExecStart=\${NODE_BIN@Q} /opt/chordv-node-agent/current/dist/src/main.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/chordv-node-agent

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable xray.service chordv-xray-apply.path chordv-node-agent.service
# Xray comes up with base + metering fragment only; the inbound arrives later
# as an ENSURE_INBOUND command, so a fresh host is healthy but serves nobody.
systemctl restart xray.service
systemctl start chordv-xray-apply.path

echo "==> 启动 Agent（首次启动将使用注册令牌完成接入）…"
systemctl restart chordv-node-agent.service
sleep 2
if systemctl is-active --quiet chordv-node-agent.service; then
  echo "安装完成：Agent 已启动并正在向控制面注册。稍后在后台确认节点状态变为已就绪。"
else
  echo "警告：Agent 服务未进入 active 状态，请查看日志：journalctl -u chordv-node-agent -n 50" >&2
  exit 1
fi
`;
}

/**
 * Installs Xray and the root half of inbound deployment. Rendered separately so
 * a regression can run exactly this section in a container, and placed after
 * the agent release is published so a failure here cannot strand a half-staged
 * agent. The binary comes from THIS origin — the same trust anchor as the agent
 * tarball — rather than a second host the installer would also have to trust.
 */
export function renderXrayInstall(): string {
  return `# --- chordv:xray-install:begin ---
XRAY_MARKER="# chordv-managed: xray"
XRAY_UNIT=/etc/systemd/system/xray.service
# This host may already run Xray for something else — an operator's own
# deployment, or a leftover from before. Replacing that unit would point it at a
# config directory holding no user-facing inbound and restart it, silently
# taking the existing service offline. Only a unit this installer wrote may be
# replaced; anything else requires a deliberate migration.
if [[ -e "\$XRAY_UNIT" ]] && ! grep -qF "\$XRAY_MARKER" "\$XRAY_UNIT"; then
  echo "安装失败：\$XRAY_UNIT 已存在且不是本安装脚本管理的 Xray 服务。" >&2
  echo "如需交给 ChordV 托管：先备份现有 Xray 配置与单元、停止并删除该单元，再重跑本命令；" >&2
  echo "否则本次安装会用只含计量片段的配置目录替换它，现有代理服务将立即中断。" >&2
  exit 1
fi
if [[ -e /etc/systemd/system/xray.service.d ]]; then
  echo "安装失败：/etc/systemd/system/xray.service.d 存在本机自定义的 Xray 覆盖配置，请人工确认后再安装。" >&2
  exit 1
fi

XRAY_USER="chordv-xray"
XRAY_BIN=/usr/local/bin/xray
XRAY_CONF_DIR=/etc/chordv/xray/conf.d
HELPER_DIR=/usr/local/lib/chordv
REQUEST_DIR=/var/lib/chordv-node-agent/xray

if ! id "\$XRAY_USER" >/dev/null 2>&1; then
  useradd --system --home /var/lib/chordv-xray --shell /usr/sbin/nologin "\$XRAY_USER"
fi

# Staged inside the installer's own staging directory so the existing EXIT
# cleanup removes it too — replacing that trap here would drop the agent
# staging cleanup along with it.
XRAY_STAGING="$(mktemp -d "\$STAGING_DIR/xray.XXXXXX")"
curl -fsSL --connect-timeout 15 --max-time 600 \\
  "\$API_BASE/agent-download/xray/\$ARCH" -o "\$XRAY_STAGING/xray.tar.gz"
curl -fsSL --connect-timeout 15 --max-time 60 \\
  "\$API_BASE/agent-download/xray/\$ARCH.sha256" -o "\$XRAY_STAGING/xray.sha256"
# The digest is served from the same origin, so it proves integrity (a truncated
# or swapped-mid-publish artifact), not authorship — authorship is the TLS origin.
( cd "\$XRAY_STAGING" && printf '%s  xray.tar.gz\\n' "$(cut -d' ' -f1 < xray.sha256)" | sha256sum -c - )
tar --no-same-owner --no-same-permissions -xzf "\$XRAY_STAGING/xray.tar.gz" -C "\$XRAY_STAGING"
[[ -f "\$XRAY_STAGING/xray" ]] || { echo "安装失败：Xray 包中缺少 xray 可执行文件。" >&2; exit 1; }
install -m 0755 -o root -g root "\$XRAY_STAGING/xray" "\$XRAY_BIN"
"\$XRAY_BIN" version >/dev/null

# Xray's configuration belongs to root. The agent must never be able to write
# what root then runs, and must never be able to read the Reality private key.
install -d -m 0755 -o root -g root /etc/chordv/xray "\$XRAY_CONF_DIR"
install -m 0644 -o root -g root "\$CURRENT_LINK/deploy/xray-base.json" "\$XRAY_CONF_DIR/00-base.json"
install -m 0644 -o root -g root "\$CURRENT_LINK/deploy/xray-api.fragment.json" "\$XRAY_CONF_DIR/10-api.json"

# The helper is copied OUT of the agent-owned release directory: run from there,
# a compromised agent could rewrite the script root executes.
install -d -m 0755 -o root -g root "\$HELPER_DIR"
install -m 0755 -o root -g root "\$CURRENT_LINK/dist/src/xray-apply.js" "\$HELPER_DIR/xray-apply.js"
install -d -m 0700 -o "\$SERVICE_USER" -g "\$SERVICE_USER" "\$REQUEST_DIR"

cat > "\$XRAY_UNIT" <<XRAYUNIT
\$XRAY_MARKER
[Unit]
Description=Xray Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=\$XRAY_USER
ExecStart=\$XRAY_BIN run -confdir \$XRAY_CONF_DIR
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/chordv/xray

[Install]
WantedBy=multi-user.target
XRAYUNIT

cat > /etc/systemd/system/chordv-xray-apply.service <<APPLYUNIT
[Unit]
Description=Apply ChordV Xray inbound configuration
After=xray.service

[Service]
Type=oneshot
User=root
ExecStart=\${NODE_BIN@Q} \$HELPER_DIR/xray-apply.js
PrivateTmp=true
APPLYUNIT

cat > /etc/systemd/system/chordv-xray-apply.path <<APPLYPATH
[Unit]
Description=Watch for ChordV inbound apply requests

[Path]
PathChanged=\$REQUEST_DIR/pending.json
Unit=chordv-xray-apply.service

[Install]
WantedBy=multi-user.target
APPLYPATH

rm -rf -- "\$XRAY_STAGING"
# --- chordv:xray-install:end ---
`;
}
