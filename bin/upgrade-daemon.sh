#!/usr/bin/env bash
# bin/upgrade-daemon.sh — service-aware stavR daemon upgrade with rollback.
#
# Phase 4 of the operator-companion refactor
# (proposed/governor-observe-only-bom.md). The Tauri Governor's tray
# "Upgrade Daemon" item shells out to this script via
# `governor::service::spawn_upgrade`. The contract:
#
#   1. Capture OLD = git rev-parse HEAD
#   2. Stop the OS-native stavr service (systemctl --user on Linux,
#      launchctl bootout/bootstrap on macOS)
#   3. git pull --ff-only
#   4. npm ci
#   5. npm run build
#   6. Start the service; poll /healthz (~60 s)
#   7. On any failure in 3-6: git reset --hard $OLD -> npm ci -> npm run
#      build -> start the service -> exit non-zero with a clear reason
#   8. On success: report the new commit
#
# Rollback contract — ALWAYS leaves the daemon running the pre-upgrade
# commit when anything goes wrong. The OS-native service supervises both
# the upgraded and the rolled-back daemon; this script never spawns a
# detached daemon process directly.
#
# Test the rollback path with --force-build-fail (no network / git
# operations actually need to fail — the script skips the real build
# and emulates a non-zero exit so the rollback branch is exercised
# against the live service).
#
# Exit codes:
#   0 = upgrade ok
#   2 = upgrade failed, rollback succeeded
#   3 = upgrade failed AND rollback failed (operator-only)
#   4 = couldn't even capture OLD; nothing was attempted

# governor-polish Cluster D (PR #77 security review) — promote to the
# full strict set. The script's rollback contract already uses explicit
# `|| return 1` / `|| true` markers + `if` guards on every command that
# may legitimately fail, so `errexit` is belt-and-braces against a
# future contributor adding an un-guarded step that should abort to
# rollback instead of plowing on. `pipefail` is preventive: the current
# script has no pipelines but new ones (e.g. `git log … | head`) would
# silently swallow upstream failures without it.
set -euo pipefail

# ---------------------------------------------------------------------------
# Args + defaults
# ---------------------------------------------------------------------------

FORCE_BUILD_FAIL=0
HEALTH_URL="${STAVR_HEALTH_URL:-http://127.0.0.1:7777/healthz}"
HEALTH_TIMEOUT="${STAVR_HEALTH_TIMEOUT_SEC:-60}"
LINUX_UNIT="${STAVR_SERVICE_NAME:-stavr.service}"
MACOS_LABEL="${STAVR_SERVICE_LABEL:-com.stavr.daemon}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force-build-fail) FORCE_BUILD_FAIL=1; shift ;;
        --health-url)       HEALTH_URL="$2"; shift 2 ;;
        --health-timeout)   HEALTH_TIMEOUT="$2"; shift 2 ;;
        --linux-unit)       LINUX_UNIT="$2"; shift 2 ;;
        --macos-label)      MACOS_LABEL="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 64 ;;
    esac
done

OS="$(uname -s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
    local ts; ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[upgrade-daemon][$ts] $*"
}

stop_service() {
    log "stopping service"
    case "$OS" in
        Linux)
            systemctl --user stop "$LINUX_UNIT"
            ;;
        Darwin)
            local uid; uid="$(id -u)"
            # `bootout` is the canonical way to stop a launchd agent;
            # bootstrap brings it back. Ignore non-zero on bootout when
            # the agent wasn't loaded — start_service will surface a
            # clearer error.
            launchctl bootout "gui/${uid}/${MACOS_LABEL}" 2>/dev/null || true
            ;;
        *) echo "unsupported OS: $OS" >&2; return 1 ;;
    esac
}

start_service() {
    log "starting service"
    case "$OS" in
        Linux)
            systemctl --user start "$LINUX_UNIT"
            ;;
        Darwin)
            local uid; uid="$(id -u)"
            local plist="$HOME/Library/LaunchAgents/${MACOS_LABEL}.plist"
            if [[ ! -f "$plist" ]]; then
                echo "launchd plist not found at $plist" >&2
                return 1
            fi
            launchctl bootstrap "gui/${uid}" "$plist"
            ;;
        *) echo "unsupported OS: $OS" >&2; return 1 ;;
    esac
}

wait_healthy() {
    log "polling $HEALTH_URL (timeout ${HEALTH_TIMEOUT}s)"
    local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while [[ $(date +%s) -lt $deadline ]]; do
        if curl --silent --fail --max-time 3 -o /dev/null "$HEALTH_URL"; then
            log "/healthz ok — daemon ready"
            return 0
        fi
        sleep 2
    done
    return 1
}

rollback_to() {
    local old="$1"
    log "ROLLBACK to $old"
    if ! git reset --hard "$old"; then
        log "ROLLBACK FAILED: git reset"; return 1
    fi
    if ! npm ci; then
        log "ROLLBACK FAILED: rollback npm ci"; return 1
    fi
    if ! npm run build; then
        log "ROLLBACK FAILED: rollback npm run build"; return 1
    fi
    stop_service || true
    if ! start_service; then
        log "ROLLBACK FAILED: post-rollback start_service"; return 1
    fi
    if ! wait_healthy; then
        log "ROLLBACK FAILED: post-rollback /healthz did not return within ${HEALTH_TIMEOUT}s"
        return 1
    fi
    log "rollback complete — daemon on $old"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

cd "$REPO_ROOT" || { echo "could not cd to $REPO_ROOT"; exit 4; }
log "cwd = $REPO_ROOT"

OLD_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$OLD_COMMIT" ]]; then
    log "could not resolve current HEAD commit — is this a git checkout?"
    exit 4
fi
log "pre-upgrade commit = $OLD_COMMIT"

# Single upgrade attempt wrapped so any failure jumps to the rollback path.
upgrade_attempt() {
    stop_service || return 1

    if [[ "$FORCE_BUILD_FAIL" == "1" ]]; then
        log "--force-build-fail set — emulating a build failure to exercise the rollback path"
        return 1
    fi

    log "git pull --ff-only"
    git pull --ff-only || return 1

    log "npm ci"
    npm ci || return 1

    log "npm run build"
    npm run build || return 1

    start_service || return 1
    wait_healthy || return 1
}

if upgrade_attempt; then
    NEW_COMMIT="$(git rev-parse HEAD)"
    log "UPGRADE OK — daemon now on $NEW_COMMIT (was $OLD_COMMIT)"
    exit 0
fi

log "UPGRADE FAILED — entering rollback"
if rollback_to "$OLD_COMMIT"; then
    exit 2
else
    log "operator must intervene manually — daemon may not be running"
    exit 3
fi
