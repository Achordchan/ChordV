import { Controller, Get, Param } from "@nestjs/common";
import { AgentRegisterService } from "../agent/agent-register.service";

/**
 * Renders the one-shot VPS install script for an agent-native node. UNAUTHENTICATED
 * by design: the script carries no secrets beyond the one-time registration token
 * already embedded in the URL, and `curl | bash` cannot authenticate. A spent or
 * expired token still renders a script — its very first action (registering) will
 * fail with a clear message, which beats an opaque 404 for an operator who lost
 * track of which command was which.
 *
 * The agent payload itself is served by the sibling /agent-download route, so the
 * VPS only ever needs this single public origin.
 */
const API_BASE_PLACEHOLDER = "__CHORDV_API_BASE__";

@Controller()
export class AgentInstallController {
  constructor(private readonly registerService: AgentRegisterService) {}

  @Get("agent-install/:token.sh")
  async installScript(@Param("token") token: string) {
    const resolved = await this.registerService.resolveTokenNode(token).catch(() => null);
    if (!resolved) {
      return shellResponse(renderErrorScript("该安装链接无效（注册令牌不存在）。请在后台重新生成安装命令。"));
    }
    if (!resolved.usable) {
      return shellResponse(renderErrorScript(
        "该安装链接已失效（注册令牌已被使用或已过期）。请在后台重新生成安装命令。"
      ));
    }
    // The origin that served this script is the origin the agent talks to; the
    // install command on the admin UI is built from the same base.
    const apiBase = (process.env.CHORDV_PUBLIC_BASE_URL?.trim() || API_BASE_PLACEHOLDER).replace(/\/$/, "");
    return shellResponse(renderInstallScript({ token, apiBase }));
  }
}

function shellResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function renderErrorScript(message: string) {
  return `#!/usr/bin/env bash
set -euo pipefail
echo "ChordV Agent 安装中止：${message}" >&2
exit 1
`;
}

function renderInstallScript({ token, apiBase }: { token: string; apiBase: string }) {
  return `#!/usr/bin/env bash
# ChordV Node Agent 一键安装（由控制面动态生成，token 单次有效）
set -euo pipefail

API_BASE="${apiBase}"
REGISTER_TOKEN="${token}"
INSTALL_DIR="/opt/chordv-node-agent"
ENV_FILE="/etc/chordv/node-agent.env"
SERVICE_USER="chordv-agent"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "安装失败：请使用 root 运行。" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) ARCH="linux-x64" ;;
  aarch64|arm64) ARCH="linux-arm64" ;;
  *) echo "安装失败：不支持的架构 $(uname -m)。" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "安装失败：目标机器未安装 Node.js（要求 20.x）。请先安装 Node.js 后重试。" >&2
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
CHORDV_API_BASE_URL=\$API_BASE
CHORDV_REGISTER_TOKEN=\$REGISTER_TOKEN
AGENT_DATABASE_PATH=/var/lib/chordv-node-agent/agent.db
AGENT_CREDENTIALS_PATH=/var/lib/chordv-node-agent/credentials.json
EOF
chown "\$SERVICE_USER:\$SERVICE_USER" "\$ENV_FILE"
chmod 0640 "\$ENV_FILE"

cat > /etc/systemd/system/chordv-node-agent.service <<'UNIT'
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
ExecStart=/usr/bin/node /opt/chordv-node-agent/dist/src/main.js
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
