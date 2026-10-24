#!/bin/bash
# Poll OpenCode device flow token endpoint until user authorizes.
# Usage: device-poll.sh <device_code> <interval>
set -euo pipefail
DEVICE_CODE="${1:?device_code required}"
INTERVAL="${2:-5}"
URL="https://opencode.ai/console/auth/device/token"
for i in $(seq 1 120); do
  RESP=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"urn:ietf:params:oauth:grant-type:device_code\",\"device_code\":\"$DEVICE_CODE\",\"client_id\":\"opencode-cli\"}")
  if echo "$RESP" | grep -q "access_token"; then
    echo "AUTHORIZED"
    echo "$RESP" | python3 -m json.tool
    exit 0
  fi
  if echo "$RESP" | grep -q "expired_token\|access_denied"; then
    echo "FAILED: $RESP"
    exit 1
  fi
  echo "waiting... ($i)"
  sleep "$INTERVAL"
done
echo "TIMEOUT: device code expired"
exit 1
