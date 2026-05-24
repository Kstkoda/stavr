#!/bin/sh
# Bombardment Phase 3a — daemon container entrypoint.
#
# Translates env-var config into the right `stavr daemon start` flags,
# then exec's into the daemon. POSIX sh on purpose — the runtime image
# is bookworm-slim and we don't need bash for this.
#
# Env contract (defaults set in the Dockerfile):
#   STAVR_HOME, STAVR_PORT, STAVR_BIND_HOST  — passed through
#   STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH       — '1' adds the flag
#   STAVR_PEER_ID                            — read by federation/index.ts
#   STAVR_HARDENING_SEED                     — read by bombardment/seed.ts
#
# Anything else the operator passes after `docker run ... <image> -- <args>`
# becomes "$@" and is appended verbatim (lets the rig override --port,
# pass --log-format json, etc. without rebuilding).

set -eu

PORT="${STAVR_PORT:-7777}"
BIND_HOST="${STAVR_BIND_HOST:-0.0.0.0}"

EXTRA_FLAGS=""
if [ "${STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH:-0}" = "1" ]; then
    EXTRA_FLAGS="--allow-non-local-without-auth"
fi

# `--log-format json` keeps container logs grep-able by structured
# tooling (the bombardment harness reads them on failure). The flag
# defaults to text when STAVR_LOG_FORMAT is unset.
LOG_FORMAT="${STAVR_LOG_FORMAT:-json}"

echo "[stavr-entrypoint] starting daemon" \
    "peer_id=${STAVR_PEER_ID:-unset}" \
    "home=${STAVR_HOME}" \
    "port=${PORT}" \
    "bind=${BIND_HOST}" \
    "log_format=${LOG_FORMAT}" \
    "seed=${STAVR_HARDENING_SEED:-unset}" >&2

# exec so node becomes PID 1 (under tini's wrapping), receives SIGTERM
# from `docker stop`, and the daemon's graceful-shutdown path runs.
exec node /app/dist/cli.js daemon start \
    --port "${PORT}" \
    --bind-host "${BIND_HOST}" \
    --log-format "${LOG_FORMAT}" \
    ${EXTRA_FLAGS} \
    "$@"
