#!/bin/sh
# opencode2api entrypoint：起 opencode serve + 网关
set -e

# 认证注入：若提供了 auth.json（OAuth 登录产物），放到 CLI 读取的位置
if [ -n "${OPENCODE_AUTH_FILE:-}" ] && [ -f "$OPENCODE_AUTH_FILE" ]; then
  mkdir -p "$HOME/.local/share/opencode"
  cp "$OPENCODE_AUTH_FILE" "$HOME/.local/share/opencode/auth.json"
  echo "[entrypoint] auth.json injected -> $HOME/.local/share/opencode/auth.json"
fi

echo "[entrypoint] starting opencode serve on :4096"
opencode serve --port 4096 --hostname 0.0.0.0 &
SERVE_PID=$!

# 等 serve health
for i in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null http://127.0.0.1:4096/global/health 2>/dev/null; then
    echo "[entrypoint] opencode serve ready"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "[entrypoint] opencode serve failed to start" >&2
    exit 1
  fi
  sleep 1
done

echo "[entrypoint] starting gateway on :$PORT"
exec node /app/gateway.js