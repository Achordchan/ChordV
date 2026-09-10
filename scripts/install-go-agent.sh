#!/usr/bin/env bash
# Rendered by the running backend; public parameters and credentials are quoted
# as literal values, never evaluated as shell source from an external response.
set -euo pipefail
umask 077
API_BASE=@@ORIGIN@@
REGISTER_TOKEN=@@TOKEN@@
NODE_ID=@@NODE_ID@@
TOKEN_HASH=@@TOKEN_HASH@@
TOKEN_USABLE=@@USABLE@@
SPEC=@@SPEC@@
VERSION=@@VERSION@@
AMD64_SHA=@@AMD64_SHA@@
ARM64_SHA=@@ARM64_SHA@@

fail() { printf '安装中止：%s\n' "$1" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || fail '请以 root 执行安装命令'
[[ $(uname -s) == Linux ]] || fail '仅支持使用 systemd 的 Linux VPS'
for command in curl sha256sum systemctl flock runuser useradd install readlink sync; do
  command -v "$command" >/dev/null || fail "缺少系统命令：$command，请先安装对应系统软件包"
done
[[ -d /run/systemd/system ]] || fail '未检测到 systemd，暂不支持容器或其他服务管理器'
case $(uname -m) in
  x86_64) ARCH=amd64; EXPECTED_SHA=$AMD64_SHA ;;
  aarch64|arm64) ARCH=arm64; EXPECTED_SHA=$ARM64_SHA ;;
  *) fail '仅支持 amd64 和 arm64 架构' ;;
esac

INSTALL_DIR=/opt/chordv-node-agent
STATE_DIR=/var/lib/chordv-node-agent
ENV_FILE=/etc/chordv/node-agent.env
IDENTITY=/etc/chordv/go-install.identity
UNIT=/etc/systemd/system/chordv-node-agent.service
MARKER='# chordv-managed: go-agent'
SERVICE=chordv-node-agent.service
for owned in /opt /var/lib /etc/chordv "$INSTALL_DIR" "$INSTALL_DIR/releases" "$STATE_DIR" "$ENV_FILE" "$IDENTITY" "$UNIT"; do
  [[ ! -L $owned ]] || fail "受管路径为符号链接：$owned，请先检查现有安装"
done
# The lock is outside service-writable state. It covers preflight as well as
# promotion, so two installers cannot both pass the empty-host checks.
exec 9>/run/lock/chordv-go-install.lock
flock -n 9 || fail '另一项 ChordV 安装正在执行'
EXPECTED_IDENTITY=$(printf '%s\n%s' "$NODE_ID" "$TOKEN_HASH")
EXISTING=0
if [[ -f $IDENTITY ]]; then
  [[ $(cat "$IDENTITY") == "$EXPECTED_IDENTITY" ]] || fail '本机属于另一接入任务，已保留原身份和计量数据；请先完成明确的迁移'
  EXISTING=1
else
  [[ $TOKEN_USABLE == 1 ]] || fail '注册令牌已使用或过期，请在后台重新生成安装命令'
  [[ ! -e $ENV_FILE && ! -e $INSTALL_DIR && ! -e $STATE_DIR ]] || fail '本机已有 ChordV 文件，不能用新注册命令覆盖；请先完成身份迁移'
fi
FRAGMENT=$(systemctl show -p FragmentPath --value "$SERVICE" 2>/dev/null || true)
DROPINS=$(systemctl show -p DropInPaths --value "$SERVICE" 2>/dev/null || true)
[[ -z $DROPINS ]] || fail 'Agent 服务存在额外配置，请先核对，不能自动覆盖'
if [[ -n $FRAGMENT ]]; then
  [[ $EXISTING == 1 && $FRAGMENT == "$UNIT" ]] || fail 'Agent 服务名已被已有服务占用'
  grep -qxF "$MARKER" "$UNIT" || fail '现有服务不是此 Go 安装器管理的服务'
fi
for unitdir in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
  [[ ! -e "$unitdir/$SERVICE.d" ]] || fail 'Agent 服务存在附加配置目录'
done

STAGE=$(mktemp -d /tmp/chordv-go-install.XXXXXX)
PROMOTING=0
WAS_ACTIVE=0
COMMITTED=0
cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [[ $PROMOTING == 1 && $COMMITTED == 0 ]]; then
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    # Restore only files this invocation replaced; credentials and the durable
    # queue are always retained, including a first registration before failure.
    if [[ -f $STAGE/old.env ]]; then cp -p "$STAGE/old.env" "$ENV_FILE"; fi
    if [[ -f $STAGE/old.unit ]]; then cp -p "$STAGE/old.unit" "$UNIT"; fi
    if [[ -f $STAGE/old.link ]]; then
      if [[ -L $INSTALL_DIR/.rollback-next ]]; then rm -f "$INSTALL_DIR/.rollback-next"; fi
      ln -s "$(cat "$STAGE/old.link")" "$INSTALL_DIR/.rollback-next"
      mv -fT "$INSTALL_DIR/.rollback-next" "$INSTALL_DIR/current"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ $WAS_ACTIVE == 1 ]]; then systemctl start "$SERVICE" 9>&- >/dev/null 2>&1 || true; fi
    printf '%s\n' '安装未完成：已有身份和计量数据已保留，可用同一命令重试。' >&2
  fi
  rm -rf "$STAGE"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' '正在下载并校验 Go agent…'
curl -fsSL --proto '=https,http' --proto-redir '=https' --connect-timeout 15 --max-time 600 \
  "$API_BASE/api/agent-download/go/$VERSION/$ARCH" -o "$STAGE/chordv-agent" || fail 'Go agent 下载失败，已有服务未修改'
printf '%s  %s\n' "$EXPECTED_SHA" "$STAGE/chordv-agent" | sha256sum -c - >/dev/null || fail 'Go agent 校验和不一致，拒绝执行'
chmod 0755 "$STAGE/chordv-agent"
[[ $("$STAGE/chordv-agent" --version) == "$VERSION" ]] || fail '二进制版本与后台发布版本不一致'
printf '%s\n' "$SPEC" > "$STAGE/spec.json"
PANEL_PID=$(systemctl show -p MainPID --value x-ui.service)
[[ $PANEL_PID =~ ^[0-9]+$ ]] || fail '无法读取 x-ui.service 进程'
printf '%s\n' '正在只读检查面板版本、统计配置和实际入站…'
"$STAGE/chordv-agent" --inspect-panel --panel-pid "$PANEL_PID" --spec-file "$STAGE/spec.json" > "$STAGE/panel.env" \
  || fail '面板预检失败，已有面板与 Agent 服务未修改'
DISCOVERED_API=''
DISCOVERED_TAG=''
while IFS='=' read -r key value; do
  case "$key" in
    XRAY_API_ADDRESS) DISCOVERED_API=$value ;;
    XRAY_INBOUND_TAG) DISCOVERED_TAG=$value ;;
  esac
done < "$STAGE/panel.env"
[[ -n $DISCOVERED_API && -n $DISCOVERED_TAG ]] || fail '面板预检未返回完整的 API 与 tag'

# No business files are changed until all downloads and panel checks pass.
if ! id chordv-agent >/dev/null 2>&1; then
  useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin chordv-agent
fi
[[ $(id -u chordv-agent) -ne 0 ]] || fail 'chordv-agent 账户不得拥有 root 身份'
chgrp chordv-agent "$STAGE" "$STAGE/spec.json"
chmod 0710 "$STAGE"
chmod 0640 "$STAGE/spec.json"
runuser -u chordv-agent -- env -i XRAY_API_ADDRESS="$DISCOVERED_API" XRAY_INBOUND_TAG="$DISCOVERED_TAG" \
  "$STAGE/chordv-agent" --verify-inbound --spec-file "$STAGE/spec.json" \
  || fail '服务用户无法校验实际入站，请检查面板 API 或 socket 权限；现有服务未修改'
install -d -m 0750 -o root -g root /etc/chordv
# Mark the accepted task before creating its other paths. An interrupted first
# install can then resume without mistaking its own partial files for a legacy
# identity. This marker never authorizes replacing another node's data.
printf '%s\n' "$EXPECTED_IDENTITY" > "$STAGE/identity"
install -m 0600 -o root -g root "$STAGE/identity" "$IDENTITY.new"
mv -fT "$IDENTITY.new" "$IDENTITY"
install -d -m 0755 -o root -g root "$INSTALL_DIR" "$INSTALL_DIR/releases"
install -d -m 0750 -o chordv-agent -g chordv-agent "$STATE_DIR"
RELEASE="$INSTALL_DIR/releases/$VERSION-$EXPECTED_SHA"
[[ ! -L $RELEASE && ! -L $RELEASE/chordv-agent && ! -L $RELEASE/chordv-agent.new ]] || fail '现有发布目录异常'
if [[ -f $RELEASE/chordv-agent ]]; then
  printf '%s  %s\n' "$EXPECTED_SHA" "$RELEASE/chordv-agent" | sha256sum -c - >/dev/null || fail '现有发布目录校验失败'
else
  [[ ! -e $RELEASE/chordv-agent ]] || fail '发布程序路径不是普通文件'
  install -d -m 0755 -o root -g root "$RELEASE"
  install -m 0755 -o root -g root "$STAGE/chordv-agent" "$RELEASE/chordv-agent.new"
  mv -T "$RELEASE/chordv-agent.new" "$RELEASE/chordv-agent"
  sync -f "$RELEASE"
fi
runuser -u chordv-agent -- "$RELEASE/chordv-agent" --version >/dev/null || fail '服务用户无法执行 Go agent'

if [[ -e $INSTALL_DIR/current && ! -L $INSTALL_DIR/current ]]; then fail 'current 路径必须是受管发布链接'; fi
[[ ! -L $INSTALL_DIR/current ]] || readlink "$INSTALL_DIR/current" > "$STAGE/old.link"
[[ ! -f $ENV_FILE ]] || cp -p "$ENV_FILE" "$STAGE/old.env"
[[ ! -f $UNIT ]] || cp -p "$UNIT" "$STAGE/old.unit"
if systemctl is-active --quiet "$SERVICE"; then WAS_ACTIVE=1; fi
cat > "$STAGE/new.env" <<EOF
CHORDV_API_BASE_URL=$API_BASE
CHORDV_REGISTER_TOKEN=$REGISTER_TOKEN
AGENT_DATABASE_PATH=$STATE_DIR/agent.db
AGENT_CREDENTIALS_PATH=$STATE_DIR/credentials.json
AGENT_REMOVE_UNKNOWN_USERS=false
AGENT_ADOPT_EXISTING_ACCOUNTS=false
EOF
cat "$STAGE/panel.env" >> "$STAGE/new.env"
cat > "$STAGE/new.unit" <<'UNIT'
# chordv-managed: go-agent
[Unit]
Description=ChordV Go Agent
After=network-online.target x-ui.service
Wants=network-online.target
[Service]
Type=simple
User=chordv-agent
Group=chordv-agent
WorkingDirectory=/var/lib/chordv-node-agent
EnvironmentFile=/etc/chordv/node-agent.env
ExecStart=/opt/chordv-node-agent/current/chordv-agent
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/chordv-node-agent
[Install]
WantedBy=multi-user.target
UNIT

PROMOTING=1
if [[ $WAS_ACTIVE == 1 ]]; then systemctl stop "$SERVICE"; fi
install -m 0640 -o root -g chordv-agent "$STAGE/new.env" "$ENV_FILE.new"
mv -fT "$ENV_FILE.new" "$ENV_FILE"
install -m 0644 -o root -g root "$STAGE/new.unit" "$UNIT.new"
mv -fT "$UNIT.new" "$UNIT"
# SIGKILL can leave a not-yet-promoted link. Only this task's root-owned
# temporary link is removed; published releases and durable state stay intact.
if [[ -e $INSTALL_DIR/.current-next || -L $INSTALL_DIR/.current-next ]]; then
  [[ -L $INSTALL_DIR/.current-next ]] || fail '发布临时链接路径异常'
  rm -f "$INSTALL_DIR/.current-next"
fi
ln -s "$RELEASE" "$INSTALL_DIR/.current-next"
mv -fT "$INSTALL_DIR/.current-next" "$INSTALL_DIR/current"
sync -f /etc/chordv
sync -f "$INSTALL_DIR"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl start "$SERVICE" 9>&-
# Starting a process is not registration success. A bounded local health probe
# waits for persisted credentials and state; all remote status uses SSE.
printf '%s\n' '等待首次注册和本地状态落盘…'
HEALTHY=0
for attempt in {1..20}; do
  if runuser -u chordv-agent -- env -i \
    CHORDV_API_BASE_URL="$API_BASE" AGENT_DATABASE_PATH="$STATE_DIR/agent.db" \
    AGENT_CREDENTIALS_PATH="$STATE_DIR/credentials.json" \
    XRAY_API_ADDRESS="$DISCOVERED_API" XRAY_INBOUND_TAG="$DISCOVERED_TAG" \
    "$INSTALL_DIR/current/chordv-agent" --health \
    > "$STAGE/health.json" 2>/dev/null; then HEALTHY=1; break; fi
  sleep 3
done
[[ $HEALTHY == 1 ]] || fail '首次注册未完成，请运行 journalctl -u chordv-node-agent -n 50 查看原因后重试'
COMMITTED=1
printf '%s\n' 'Go agent 已注册。请回到后台查看入站校验结果；完成实际连接与计量验收后再手工激活。'
