import { Controller, Get, Headers, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { AgentRegisterService } from "./agent-register.service";

/**
 * Renders the one-shot VPS install script for an agent-native node. UNAUTHENTICATED
 * by design: the script carries no secrets beyond the one-time registration token
 * already embedded in the URL, and `curl | bash` cannot authenticate. A spent or
 * expired token still renders a script — its very first action (registering) will
 * fail with a clear message, which beats an opaque 404 for an operator who lost
 * track of which command was which.
 *
 * The agent payload itself is served by the sibling agent-download route, so the
 * VPS only ever needs this single public origin.
 */
@Controller()
export class AgentInstallController {
  constructor(private readonly registerService: AgentRegisterService) {}

  @Get("agent-install/:token.sh")
  async installScript(
    @Param("token") token: string,
    @Headers("x-forwarded-proto") forwardedProto: string | undefined,
    @Headers("host") host: string | undefined,
    @Res() response: Response
  ) {
    const resolved = await this.registerService.resolveTokenNode(token).catch(() => null);
    // The origin the script came FROM is the origin the agent talks to (the admin
    // proxy fronts both the SPA and /api on one domain). Behind the openresty
    // terminator the scheme arrives via x-forwarded-proto, falling back to the
    // direct TLS of the Node listener.
    const configuredBase = process.env.CHORDV_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
    const derivedBase = configuredBase || (host
      ? `${(forwardedProto?.split(",")[0]?.trim() || "https")}://${host.trim()}`
      : "");
    if (!resolved) {
      sendScript(response, renderErrorScript("该安装链接无效（注册令牌不存在）。请在后台重新生成安装命令。"));
      return;
    }
    if (!resolved.usable) {
      sendScript(response, renderErrorScript(
        "该安装链接已失效（注册令牌已被使用或已过期）。请在后台重新生成安装命令。"
      ));
      return;
    }
    if (!derivedBase) {
      sendScript(response, renderErrorScript("服务器未配置公网访问地址（CHORDV_PUBLIC_BASE_URL），无法生成安装脚本。"));
      return;
    }
    sendScript(response, renderInstallScript({ token, apiBase: derivedBase }));
  }
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
  return `#!/usr/bin/env bash
# ChordV Node Agent 一键安装（由控制面动态生成，token 单次有效）
set -euo pipefail

# Routes live under the Nest global /api prefix (same origin fronts the admin SPA).
API_BASE="${apiBase}/api"
REGISTER_TOKEN="${token}"
INSTALL_DIR="/opt/chordv-node-agent"
ENV_FILE="/etc/chordv/node-agent.env"
SERVICE_USER="chordv-agent"

if [[ "\$(id -u)" -ne 0 ]]; then
  echo "安装失败：请使用 root 运行。" >&2
  exit 1
fi

case "\$(uname -m)" in
  x86_64) ARCH="linux-x64" ;;
  aarch64|arm64) ARCH="linux-arm64" ;;
  *) echo "安装失败：不支持的架构 \$(uname -m)。" >&2; exit 1 ;;
esac

# The bundled native modules (better-sqlite3) and the systemd unit below both
# require a Node 20.x runtime at a FIXED path: the service cannot resolve an
# nvm/wrapped interpreter, and 18/22 fail the native ABI. Probe exactly what the
# service will execute.
NODE_BIN=""
for candidate in /usr/bin/node /usr/local/bin/node "\$(command -v node 2>/dev/null || true)"; do
  [[ -n "\$candidate" && -x "\$candidate" ]] || continue
  NODE_BIN="\$candidate"
  break
done
if [[ -z "\$NODE_BIN" ]]; then
  echo "安装失败：目标机器未安装 Node.js（要求 20.x）。请先安装 Node.js 20 后重试。" >&2
  exit 1
fi
NODE_VERSION="\$("\$NODE_BIN" --version 2>/dev/null || true)"
if [[ ! "\$NODE_VERSION" =~ ^v20\\. ]]; then
  echo "安装失败：检测到 Node.js \${NODE_VERSION:-未知}，要求 20.x（\${NODE_BIN}）。请安装 Node.js 20 后重试。" >&2
  exit 1
fi

echo "==> 下载 ChordV Node Agent (\$ARCH)…"
mkdir -p "\$INSTALL_DIR"
if ! curl -fsSL "\$API_BASE/agent-download/\$ARCH" | tar -xz -C "\$INSTALL_DIR"; then
  echo "安装失败：无法下载或解压 Agent 安装包。" >&2
  exit 1
fi
if [[ ! -f "\$INSTALL_DIR/dist/src/main.js" ]]; then
  echo "安装失败：安装包不完整（缺少 dist/src/main.js）。" >&2
  exit 1
fi

if ! id "\$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home /var/lib/chordv-node-agent --shell /usr/sbin/nologin "\$SERVICE_USER"
fi
install -d -m 0750 -o "\$SERVICE_USER" -g "\$SERVICE_USER" /var/lib/chordv-node-agent

install -d -m 0750 /etc/chordv
cat > "\$ENV_FILE" <<EOF
CHORDV_API_BASE_URL=\${API_BASE%/api}
CHORDV_REGISTER_TOKEN=\$REGISTER_TOKEN
AGENT_DATABASE_PATH=/var/lib/chordv-node-agent/agent.db
AGENT_CREDENTIALS_PATH=/var/lib/chordv-node-agent/credentials.json
EOF
chown "\$SERVICE_USER:\$SERVICE_USER" "\$ENV_FILE"
chmod 0640 "\$ENV_FILE"

cat > /etc/systemd/system/chordv-node-agent.service <<UNIT
[Unit]
Description=ChordV Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chordv-agent
Group=chordv-agent
WorkingDirectory=/opt/chordv-node-agent
EnvironmentFile=/etc/chordv/node-agent.env
ExecStart=\${NODE_BIN@Q} /opt/chordv-node-agent/dist/src/main.js
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
systemctl enable chordv-node-agent.service

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
