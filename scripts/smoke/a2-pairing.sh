#!/usr/bin/env bash
#
# Smoke test for spec 52 A2 — pairing-code authentication.
#
# Spawns a single foreground daemon, exercises the full pair flow with two
# separate $STAVR_HOME directories ("nas" and "device"), then revokes the
# device. Verifies:
#   1. `stavr pair bootstrap` returns a 6-digit code.
#   2. `stavr pair remote-host` exchanges it for a token + persists the
#      pairing on the device side at $STAVR_HOME/devices.json mode 0600.
#   3. `stavr devices list` shows the new device.
#   4. `stavr devices revoke <id>` removes it from active-only listing.
#
# Run after `npm run build`. Idempotent.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="node $ROOT/dist/cli.js"
if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "smoke: dist/cli.js missing — run 'npm run build' first" >&2
  exit 2
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t stavr-a2-smoke)"
NAS_HOME="$TMP/nas"; mkdir -p "$NAS_HOME"
DEV_HOME="$TMP/device"; mkdir -p "$DEV_HOME"
NAS_DB="$TMP/nas.db"
PORT=${PORT:-17777}

DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "==> 1/4: start daemon (loopback, no auth yet)"
STAVR_HOME="$NAS_HOME" $CLI daemon start --port "$PORT" --db "$NAS_DB" --log-format json &
DAEMON_PID=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null \
  || { echo "FAIL: healthz never came up"; exit 1; }
echo "    healthz reachable on 127.0.0.1:$PORT"

echo "==> 2/4: pair bootstrap → 6-digit code"
CODE=$(STAVR_HOME="$NAS_HOME" $CLI pair bootstrap --daemon-url "http://127.0.0.1:$PORT" | python -c 'import json,sys; print(json.load(sys.stdin)["code"])' 2>/dev/null \
  || STAVR_HOME="$NAS_HOME" $CLI pair bootstrap --daemon-url "http://127.0.0.1:$PORT" | grep -oE '"code": *"[0-9]{6}"' | grep -oE '[0-9]{6}')
if [[ ! "$CODE" =~ ^[0-9]{6}$ ]]; then
  echo "FAIL: bootstrap did not return a 6-digit code (got: $CODE)"; exit 1
fi
echo "    received code $CODE"

echo "==> 3/4: pair remote-host → token + devices.json"
STAVR_HOME="$DEV_HOME" $CLI pair remote-host \
  --daemon-url "http://127.0.0.1:$PORT" \
  --code "$CODE" \
  --name "smoke-device" >"$TMP/remote.out"
grep -q '"ok": true' "$TMP/remote.out" \
  || { echo "FAIL: pair remote-host did not succeed"; cat "$TMP/remote.out"; exit 1; }
test -f "$DEV_HOME/devices.json" \
  || { echo "FAIL: devices.json not written"; exit 1; }
grep -q '"token"' "$DEV_HOME/devices.json" \
  || { echo "FAIL: devices.json missing token field"; cat "$DEV_HOME/devices.json"; exit 1; }
echo "    token persisted to $DEV_HOME/devices.json"

echo "==> 4/4: devices list, then revoke, then verify gone"
LIST_OUT=$(STAVR_HOME="$NAS_HOME" $CLI devices list --db "$NAS_DB")
echo "$LIST_OUT" | grep -q '"name": "smoke-device"' \
  || { echo "FAIL: devices list did not show smoke-device"; echo "$LIST_OUT"; exit 1; }
DEVICE_ID=$(echo "$LIST_OUT" | grep -oE '"id": *"[a-f0-9-]+"' | head -1 | grep -oE '[a-f0-9-]{36}')
STAVR_HOME="$NAS_HOME" $CLI devices revoke "$DEVICE_ID" --db "$NAS_DB" >/dev/null \
  || { echo "FAIL: devices revoke failed"; exit 1; }
LIST_AFTER=$(STAVR_HOME="$NAS_HOME" $CLI devices list --db "$NAS_DB")
echo "$LIST_AFTER" | grep -q '"name": "smoke-device"' \
  && { echo "FAIL: device still active after revoke"; echo "$LIST_AFTER"; exit 1; }
echo "    revoked $DEVICE_ID; active list no longer shows it"

echo "SMOKE A2 OK"
