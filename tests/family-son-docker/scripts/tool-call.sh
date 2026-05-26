#!/bin/sh
# family-son-mcp test rig — drive a single MCP tools/call from son-client.
#
# Two-step handshake:
#   1. POST /mcp `initialize`       -> captures Mcp-Session-Id header
#   2. POST /mcp `tools/call <id>`  -> with the session header + args
#
# Outputs the verbatim tools/call response (including headers) to
# state/$LABEL-response.txt. Exits 0 regardless of HTTP code — the
# caller decides pass/fail based on the captured body.
#
# Usage:
#   scripts/tool-call.sh <label> <tool-id> '<json-args>' [timeout-sec]
# Example:
#   scripts/tool-call.sh 4a github.list_prs '{"owner":"Kstkoda","repo":"stavr"}'
#
# Timeout defaults to 12s for the tools/call. CONFIRM-tier calls will
# block on the operator's decision; the caller (Phase 4d) should pass
# a long enough timeout to let the operator approve.

set -eu

LABEL="${1:?usage: tool-call.sh LABEL TOOL-ID JSON-ARGS [TIMEOUT-SEC]}"
TOOL_ID="${2:?missing tool-id}"
JSON_ARGS="${3:?missing json args}"
TIMEOUT="${4:-12}"

COMPOSE_FILE="tests/family-son-docker/docker-compose.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
STATE_DIR="tests/family-son-docker/state"
TOKEN_FILE="$STATE_DIR/son-test-token"

if [ ! -f "$TOKEN_FILE" ]; then
    echo "[tool-call.sh] missing $TOKEN_FILE; run scripts/pair.sh first." >&2
    exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

mkdir -p "$STATE_DIR"
INIT_OUT="$STATE_DIR/$LABEL-init.txt"
CALL_OUT="$STATE_DIR/$LABEL-response.txt"

INIT_BODY='{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"son-client","version":"0"}}}'

# 1. initialize — captures Mcp-Session-Id from the response header.
$COMPOSE exec -T son-client curl -isS \
    -X POST http://stavr-operator:7777/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $TOKEN" \
    --data "$INIT_BODY" \
    > "$INIT_OUT" 2>&1 || true

SESSION_ID="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub(/\r/,""); print $2; exit}' "$INIT_OUT")"
if [ -z "$SESSION_ID" ]; then
    echo "[tool-call.sh] could not extract mcp-session-id; init response in $INIT_OUT" >&2
    head -20 "$INIT_OUT" >&2
    exit 1
fi

# 2. tools/call. Args are spliced in literally — caller is responsible
#    for valid JSON. id=2 because initialize used id=1.
CALL_BODY=$(printf '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"%s","arguments":%s}}' \
    "$TOOL_ID" "$JSON_ARGS")

$COMPOSE exec -T son-client curl -isS \
    --max-time "$TIMEOUT" \
    -X POST http://stavr-operator:7777/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    --data "$CALL_BODY" \
    > "$CALL_OUT" 2>&1 || true

echo "[tool-call.sh] $LABEL session=$SESSION_ID tool=$TOOL_ID" >&2
echo "[tool-call.sh] verbatim response: $CALL_OUT" >&2
