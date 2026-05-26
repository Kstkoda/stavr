#!/bin/sh
# family-son-mcp test rig — Phase 3 (bearer-auth smoke).
#
# Two POSTs to http://stavr-operator:7777/mcp from inside son-client.
# Both carry a proper MCP initialize body and the Accept header pair
# the SDK demands (json + text/event-stream); they differ only in
# whether `Authorization: Bearer <son-test-token>` is set.
#
#   1) WITHOUT bearer  -> expect HTTP 401 from the bearer-auth
#      middleware (src/transports.ts:492-512). This is the empirical
#      confirmation that the middleware mounted at boot because
#      authConfigured=true; Phase 2's startup-bind log line was
#      inference, this is the direct request-path test.
#
#   2) WITH bearer     -> expect HTTP NOT-401. The MCP SDK takes
#      over once auth passes; the exact code depends on the SDK's
#      handling of a one-shot initialize with no session header.
#      The runbook §3.6's F9 note expects 400 when the body is `{}`;
#      with a real initialize body the SDK may return 200 with an
#      MCP session id. The assertion keys on "not 401" — anything
#      else means the auth gate was satisfied.
#
# Responses are captured verbatim into state/auth-smoke-*.txt for
# the Phase 3 commit transcript.

set -eu

COMPOSE_FILE="tests/family-son-docker/docker-compose.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
STATE_DIR="tests/family-son-docker/state"
TOKEN_FILE="$STATE_DIR/son-test-token"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "[auth-smoke.sh] must be run from the repo root (no $COMPOSE_FILE)" >&2
    exit 1
fi
if [ ! -f "$TOKEN_FILE" ]; then
    echo "[auth-smoke.sh] missing $TOKEN_FILE — run scripts/pair.sh first." >&2
    exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
INIT_BODY='{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"son-client","version":"0"}}}'

mkdir -p "$STATE_DIR"
NO_TOKEN_OUT="$STATE_DIR/auth-smoke-no-token.txt"
WITH_TOKEN_OUT="$STATE_DIR/auth-smoke-with-token.txt"

# ---- 1. WITHOUT bearer ----
echo "[auth-smoke.sh] 1/2 - POST /mcp WITHOUT Authorization" >&2
$COMPOSE exec -T son-client curl -isS \
    -X POST http://stavr-operator:7777/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$INIT_BODY" \
    > "$NO_TOKEN_OUT" 2>&1 || true

NO_TOKEN_STATUS="$(head -1 "$NO_TOKEN_OUT" | awk '{print $2}')"
echo "[auth-smoke.sh]   status: $NO_TOKEN_STATUS" >&2

# ---- 2. WITH bearer ----
echo "[auth-smoke.sh] 2/2 - POST /mcp WITH Authorization: Bearer <son-test-token>" >&2
$COMPOSE exec -T son-client curl -isS \
    -X POST http://stavr-operator:7777/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $TOKEN" \
    --data "$INIT_BODY" \
    > "$WITH_TOKEN_OUT" 2>&1 || true

WITH_TOKEN_STATUS="$(head -1 "$WITH_TOKEN_OUT" | awk '{print $2}')"
echo "[auth-smoke.sh]   status: $WITH_TOKEN_STATUS" >&2

# ---- Verdict ----
PASS=1
if [ "$NO_TOKEN_STATUS" != "401" ]; then
    echo "[auth-smoke.sh] FAIL: WITHOUT bearer returned $NO_TOKEN_STATUS, expected 401" >&2
    PASS=0
fi
if [ "$WITH_TOKEN_STATUS" = "401" ]; then
    echo "[auth-smoke.sh] FAIL: WITH bearer returned 401, expected not-401" >&2
    PASS=0
fi

echo "" >&2
echo "[auth-smoke.sh] responses persisted:" >&2
echo "  $NO_TOKEN_OUT" >&2
echo "  $WITH_TOKEN_OUT" >&2

if [ "$PASS" = "1" ]; then
    echo "[auth-smoke.sh] PASS — bearer-auth gate is live (no-token=401, with-token=$WITH_TOKEN_STATUS)" >&2
    exit 0
else
    exit 2
fi
