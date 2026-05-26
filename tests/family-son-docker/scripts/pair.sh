#!/bin/sh
# family-son-mcp test rig — Phase 2d (son-side pairing over the wire).
#
# Drives the over-the-wire `/pair/complete` from inside `son-client`,
# captures the bearer token + device_id, and persists them under
# `state/` for Phase 3's bearer-auth smoke and Phase 4's chokepoint
# exercises to read. Idempotent against the operator's `stavr pair
# bootstrap` — a fresh 6-digit code is minted per invocation.
#
# Prerequisites — Phase 2 steps 2a + 2b must be complete before this:
#   2a  Operator container has paired a bootstrap device on its
#       loopback, so authConfigured=true in the daemon's devices
#       table. Driven manually (see README §3):
#         docker compose -f tests/family-son-docker/docker-compose.yml \
#           exec stavr-operator node /app/dist/cli.js pair bootstrap
#         # capture code, then:
#         docker compose -f tests/family-son-docker/docker-compose.yml \
#           exec stavr-operator curl -sS -X POST \
#             http://127.0.0.1:7777/pair/complete \
#             -H 'Content-Type: application/json' \
#             -d '{"code":"<6>","device_name":"bootstrap"}'
#
#   2b  operator/stavr.yaml has been edited to `bind: '0.0.0.0'`
#       (was `'localhost'`) and the operator container restarted:
#         docker compose -f tests/family-son-docker/docker-compose.yml \
#           restart stavr-operator
#       Verify the daemon log shows
#         "HTTP/SSE listening on 0.0.0.0:7777"
#       The startup bind-auth gate would have refused this bind if
#       authConfigured were false — successful boot is empirical proof
#       2a worked.
#
#   2c  son-client reaches the operator over the Docker network:
#         docker compose ... exec son-client \
#           curl -fsS http://stavr-operator:7777/healthz
#       returns 200 with `ok:true`.
#
# This script is 2d only — the son-side curl + bookkeeping.

set -eu

COMPOSE_FILE="tests/family-son-docker/docker-compose.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
STATE_DIR="tests/family-son-docker/state"
DEVICE_NAME="${1:-son-test}"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "[pair.sh] must be run from the repo root (no $COMPOSE_FILE here)" >&2
    exit 1
fi

mkdir -p "$STATE_DIR"

# 1. Operator opens a fresh pair window. Output is JSON with `code`,
#    a 6-digit string valid for 5 minutes (runbook §3.2).
echo "[pair.sh] requesting fresh bootstrap code from operator..." >&2
PAIR_OUT="$($COMPOSE exec -T stavr-operator node /app/dist/cli.js pair bootstrap)"
CODE="$(printf '%s' "$PAIR_OUT" | sed -n 's/.*"code": *"\([0-9]*\)".*/\1/p')"
if [ -z "$CODE" ]; then
    echo "[pair.sh] could not extract code from pair bootstrap output:" >&2
    printf '%s\n' "$PAIR_OUT" >&2
    exit 1
fi
echo "[pair.sh] code=$CODE (expires in 5 min)" >&2

# 2. son-client posts /pair/complete to the operator over the Docker
#    network — runbook §3.3 Option A (curl, no stavR install on the
#    son's side).
echo "[pair.sh] son-client posting /pair/complete with device_name=$DEVICE_NAME..." >&2
SON_OUT="$(
    $COMPOSE exec -T son-client \
        curl -sS -X POST http://stavr-operator:7777/pair/complete \
        -H 'Content-Type: application/json' \
        -d "{\"code\":\"$CODE\",\"device_name\":\"$DEVICE_NAME\"}"
)"

# 3. Extract token + device_id. Persist under state/. The token is
#    shown ONCE by the daemon — once this script exits, the only copy
#    is in state/<device>-token (gitignored).
TOKEN="$(printf '%s' "$SON_OUT" | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')"
DEVICE_ID="$(printf '%s' "$SON_OUT" | sed -n 's/.*"device_id": *"\([^"]*\)".*/\1/p')"

if [ -z "$TOKEN" ] || [ -z "$DEVICE_ID" ]; then
    echo "[pair.sh] failed to extract token or device_id from response:" >&2
    printf '%s\n' "$SON_OUT" >&2
    exit 1
fi

# `printf '%s'` (no trailing newline) so downstream `cat`/curl
# substitutions don't include a stray \n in the Authorization header.
printf '%s' "$TOKEN" > "$STATE_DIR/${DEVICE_NAME}-token"
printf '%s' "$DEVICE_ID" > "$STATE_DIR/${DEVICE_NAME}-device-id"

echo "[pair.sh] wrote $STATE_DIR/${DEVICE_NAME}-token + ${DEVICE_NAME}-device-id" >&2
echo "[pair.sh] son-test device_id=$DEVICE_ID" >&2
echo "[pair.sh] done." >&2
