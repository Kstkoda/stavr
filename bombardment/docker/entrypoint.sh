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

# F7: clear a stale pidfile carried over from a prior daemon in a
# now-defunct container, instead of blanket-passing --force on every
# boot.
#
# Container PID namespaces reset on restart: any PID written by the
# previous daemon refers to a process in the prior container's
# namespace and isn't reliably checkable from this one (procfs would
# look at THIS namespace's PID space, and a coincidental PID collision
# could falsely match an unrelated process). So a pidfile present at
# container start is, by construction, always stale — there is no
# "previous daemon in this container" to race against, because the
# container has just started. The correct mechanism is therefore to
# remove the file unconditionally on entrypoint, not to ignore the
# already-running guard at runtime.
#
# This restores the daemon's own pidfile guard for the genuine case
# (operator shells in and double-starts inside one running container)
# instead of permanently neutralising it.
PID_FILE="${STAVR_HOME}/daemon.pid"
if [ -f "$PID_FILE" ]; then
    echo "[stavr-entrypoint] clearing stale pidfile from prior container: $PID_FILE" >&2
    rm -f "$PID_FILE"
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
