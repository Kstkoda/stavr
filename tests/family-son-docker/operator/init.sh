#!/bin/sh
# family-son-mcp test rig — operator-container entrypoint.
#
# Difference from the stock bombardment/docker/entrypoint.sh: we do NOT
# pass --bind-host. The CLI then reads `network.bind` from
# /home/stavr/.stavr/stavr.yaml — that file is the single source of truth
# for the bind value across the Phase 1 (loopback) and Phase 2 (flipped
# to 0.0.0.0 after bootstrap pairing) lifecycle.
#
# We also do NOT set --allow-non-local-without-auth. The startup
# bind-auth gate (src/transports.ts:244-251) is the safety net that
# refuses non-loopback bind until at least one device is paired. Phase 2
# pairs the bootstrap device on loopback, which satisfies the gate
# before the bind-flip restart.

set -eu

PORT="${STAVR_PORT:-7777}"
LOG_FORMAT="${STAVR_LOG_FORMAT:-json}"

echo "[family-son-mcp init] starting daemon" \
    "peer_id=${STAVR_PEER_ID:-unset}" \
    "home=${STAVR_HOME}" \
    "port=${PORT}" \
    "bind=<from stavr.yaml>" \
    "log_format=${LOG_FORMAT}" >&2

exec node /app/dist/cli.js daemon start \
    --port "${PORT}" \
    --log-format "${LOG_FORMAT}" \
    "$@"
