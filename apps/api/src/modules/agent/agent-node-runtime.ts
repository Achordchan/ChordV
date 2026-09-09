/** Bootstrap an isolated runtime from the control plane's verified distribution. */
export function renderNodeRuntimeBootstrap(): string {
  return String.raw`
if [[ -z "$NODE_BIN" ]]; then
  echo "==> 准备 ChordV 专用 Node.js 20.19.0…"
  RUNTIME_ROOT=/opt/chordv-node-runtime
  RUNTIME_DIR="$RUNTIME_ROOT/v20.19.0"
  for dir in "$RUNTIME_ROOT" "$RUNTIME_DIR"; do
    [[ ! -L "$dir" ]] || { echo "安装失败：Node 运行目录不得为符号链接。" >&2; exit 1; }
  done
  install -d -m 0755 -o root -g root "$RUNTIME_ROOT"
  exec 8>"$RUNTIME_ROOT/.install.lock"
  flock -n 8 || { echo "安装失败：另一个任务正在准备 Node。" >&2; exit 1; }
  runtime_stage=$(mktemp -d "$RUNTIME_ROOT/.stage.XXXXXX")
  trap 'rm -rf -- "$runtime_stage"' EXIT
  curl -fsSL --connect-timeout 15 --max-time 600 "$API_BASE/agent-download/node/$ARCH" -o "$runtime_stage/node.tar.gz"
  curl -fsSL --connect-timeout 15 --max-time 60 "$API_BASE/agent-download/node/$ARCH.sha256" -o "$runtime_stage/node.sha256"
  runtime_sha=$(awk '{print $1}' "$runtime_stage/node.sha256")
  [[ "$runtime_sha" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "安装失败：Node 校验值无效。" >&2; exit 1; }
  (cd "$runtime_stage" && printf '%s  node.tar.gz\n' "$runtime_sha" | sha256sum -c -)
  tar --no-same-owner --no-same-permissions -xzf "$runtime_stage/node.tar.gz" -C "$runtime_stage" ./bin/node
  [[ -f "$runtime_stage/bin/node" && ! -L "$runtime_stage/bin/node" ]] || { echo "安装失败：Node 包结构无效。" >&2; exit 1; }
  chmod 0755 "$runtime_stage" "$runtime_stage/bin" "$runtime_stage/bin/node"
  [[ "$(runuser -u "$SERVICE_USER" -- "$runtime_stage/bin/node" --version)" == v20.19.0 ]] || { echo "安装失败：Node 版本或系统兼容性不符。" >&2; exit 1; }
  if [[ -e "$RUNTIME_DIR" ]]; then
    echo "安装失败：专用 Node 目录已存在但不可用，请检查 $RUNTIME_DIR；保留原目录。" >&2
    exit 1
  fi
  rm "$runtime_stage/node.tar.gz" "$runtime_stage/node.sha256"
  mv "$runtime_stage" "$RUNTIME_DIR"
  trap - EXIT
  NODE_BIN="$RUNTIME_DIR/bin/node"
  flock -u 8
fi
`;
}
