#!/usr/bin/env bash
# install-launchd.sh — write the stavR LaunchAgent plist, print operator
# next-steps. CC builds the plist; the operator runs `launchctl`.
#
# Per the os-native-governor BOM: the install script must NOT call
# launchctl itself. System-modifying actions (bootstrap, enable,
# kickstart) stay operator-run.
#
# Idempotent: re-running overwrites the plist with freshly-resolved
# values. After re-install the operator runs:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Sanity checks before writing anything ---

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-launchd.sh: this script is macOS-only. Detected: $(uname -s)" >&2
  echo "  - Linux: use bin/install-systemd.sh (Phase 1)" >&2
  echo "  - Windows: use bin/install-windows-service.ps1 (Phase 3)" >&2
  exit 1
fi

if ! command -v launchctl >/dev/null 2>&1; then
  echo "install-launchd.sh: launchctl not found on PATH. macOS launchd is required." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "install-launchd.sh: node not found on PATH. Install Node >= 20 first." >&2
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/dist/cli.js" ]]; then
  echo "install-launchd.sh: $INSTALL_DIR/dist/cli.js not found." >&2
  echo "  Run 'npm run build' from $INSTALL_DIR first." >&2
  exit 1
fi

TEMPLATE="$SCRIPT_DIR/com.stavr.daemon.plist.template"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-launchd.sh: template missing at $TEMPLATE" >&2
  exit 1
fi

# --- Resolve placeholders ---

STAVR_HOME="${STAVR_HOME:-$HOME/.stavr}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.stavr.daemon.plist"
LOG_DIR="$HOME/Library/Logs/stavr"

mkdir -p "$PLIST_DIR"
mkdir -p "$STAVR_HOME"
mkdir -p "$LOG_DIR"
mkdir -p "$INSTALL_DIR/tmp/diag-reports"

# --- Render the plist ---

sed \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  -e "s|@INSTALL_DIR@|${INSTALL_DIR}|g" \
  -e "s|@STAVR_HOME@|${STAVR_HOME}|g" \
  -e "s|@HOME_DIR@|${HOME}|g" \
  -e "s|@PATH_VALUE@|${PATH}|g" \
  "$TEMPLATE" > "$PLIST_FILE"

chmod 644 "$PLIST_FILE"

# Same belt-and-braces guard as install-systemd.sh — refuse to confirm
# install if any placeholder survived sed.
if grep -q '@[A-Z_]*@' "$PLIST_FILE"; then
  echo "install-launchd.sh: unsubstituted placeholders in $PLIST_FILE:" >&2
  grep -n '@[A-Z_]*@' "$PLIST_FILE" >&2
  exit 1
fi

# --- Validate plist XML (best-effort; plutil is on every macOS) ---

if command -v plutil >/dev/null 2>&1; then
  if ! plutil -lint "$PLIST_FILE" >/dev/null 2>&1; then
    echo "install-launchd.sh: plutil rejected the rendered plist:" >&2
    plutil -lint "$PLIST_FILE" >&2 || true
    exit 1
  fi
fi

# --- Operator next-steps ---

UID_NUM="$(id -u)"

cat <<EOF
✓ Wrote ${PLIST_FILE}
  install dir: ${INSTALL_DIR}
  node:        ${NODE_BIN}
  STAVR_HOME:  ${STAVR_HOME}
  logs:        ${LOG_DIR}/{stdout,stderr}.log

Next steps (the install script does NOT run these — they modify your
system and are operator-owned):

  launchctl bootstrap gui/${UID_NUM} ${PLIST_FILE}
  launchctl enable gui/${UID_NUM}/com.stavr.daemon
  launchctl kickstart gui/${UID_NUM}/com.stavr.daemon

Verify:
  launchctl print gui/${UID_NUM}/com.stavr.daemon | head -40
  curl -s http://127.0.0.1:7777/healthz
  tail -F ${LOG_DIR}/stderr.log

If you previously installed this agent and the bootstrap fails with
"service already loaded", bootout first:
  launchctl bootout gui/${UID_NUM} ${PLIST_FILE}

Launchd crash-loop guard: ThrottleInterval=30s. launchd has no burst-
cap equivalent of systemd's StartLimitBurst — a daemon that crashes
repeatedly will be restarted every 30s indefinitely. Monitor via
${LOG_DIR}/stderr.log if the service flaps.

To uninstall:
  bin/uninstall-launchd.sh
EOF
