#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${SCRIPT_DIR}/smoke-server.log"

REST_PORT=${WEB_AGENT_REST_PORT:-3400}
REST_HOST=${WEB_AGENT_REST_HOST:-127.0.0.1}
TARGET_URL=${SMOKE_TARGET_URL:-https://example.com}

cleanup() {
  local exit_code=$?
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -f "$LOG_FILE" ]]; then
    rm -f "$LOG_FILE"
  fi
  return "$exit_code"
}
trap cleanup EXIT

cd "$ROOT_DIR"

if [[ -n "${SKIP_BUILD:-}" && "${SKIP_BUILD}" == "1" ]]; then
  echo "[smoke] SKIP_BUILD=1, skipping npm build"
else
  npm run build
fi

WEB_AGENT_REST_PORT="$REST_PORT" WEB_AGENT_REST_HOST="$REST_HOST" MCP_TRANSPORT=rest node dist/index.js >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

echo "[smoke] started server pid=$SERVER_PID on ${REST_HOST}:${REST_PORT}"

for _ in $(seq 1 80); do
  if curl -sSf "http://${REST_HOST}:${REST_PORT}/health" >/dev/null; then
    echo "[smoke] server healthy"
    break
  fi
  sleep 0.5
done

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[smoke] server died before health check. Last log:"
  tail -n 80 "$LOG_FILE"
  exit 1
fi

if ! curl -sSf "http://${REST_HOST}:${REST_PORT}/health" >/dev/null; then
  echo "[smoke] server did not become healthy in time"
  exit 1
fi

node scripts/smoke-runner.mjs \
  --base "http://${REST_HOST}:${REST_PORT}" \
  --target "$TARGET_URL"
