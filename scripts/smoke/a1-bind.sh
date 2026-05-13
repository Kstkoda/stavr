#!/usr/bin/env bash
#
# Smoke test for spec 52 A1 — configurable bind + auth gate.
#
# Exercises the two arms of the auth gate end-to-end from the built CLI:
#   1. Refusal: a non-loopback bind without auth fails fast with the documented
#      message in stderr and a non-zero exit code.
#   2. Success: the default localhost bind comes up and serves /healthz.
#
# Run after `npm run build`. Idempotent; cleans up after itself.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t cowire-smoke)"
trap 'rm -rf "$TMP"' EXIT

export COWIRE_HOME="$TMP/home"
mkdir -p "$COWIRE_HOME"

PORT=${PORT:-17777}
CONFIG="$TMP/cowire.yaml"
DB="$TMP/cowire.db"

CLI="node $ROOT/dist/cli.js"
if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "smoke: dist/cli.js missing — run 'npm run build' first" >&2
  exit 2
fi

echo "==> 1/3: refusal path (bind=0.0.0.0, require_auth=true)"
cat > "$CONFIG" <<EOF
network:
  bind: 0.0.0.0
  require_auth_when_non_local: true
EOF
set +e
out=$($CLI daemon start --port "$PORT" --db "$DB" --config "$CONFIG" --log-format json 2>&1)
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  echo "FAIL: daemon started when it should have refused"
  echo "$out"
  exit 1
fi
if ! echo "$out" | grep -q "refusing to bind non-local"; then
  echo "FAIL: expected refusal message, got:"
  echo "$out"
  exit 1
fi
echo "    refused with exit $rc as expected."

echo "==> 2/3: success path (bind=localhost)"
cat > "$CONFIG" <<EOF
network:
  bind: localhost
EOF
$CLI daemon start --port "$PORT" --db "$DB" --config "$CONFIG" --log-format json &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

# Wait up to 10s for /healthz to come up.
for i in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "FAIL: /healthz never came up on port $PORT"
  kill "$DAEMON_PID" 2>/dev/null || true
  exit 1
fi
echo "    /healthz reachable on 127.0.0.1:$PORT"

echo "==> 3/3: cowire config show reports auth-gate verdict"
verdict=$($CLI config show --config "$CONFIG" --bind-host 0.0.0.0)
echo "$verdict" | grep -q '"would_refuse": true' \
  || { echo "FAIL: config show did not flag 0.0.0.0 as would_refuse"; echo "$verdict"; exit 1; }
echo "    config show flagged would_refuse=true for 0.0.0.0"

kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true

echo "SMOKE A1 OK"
