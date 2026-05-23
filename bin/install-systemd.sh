#!/usr/bin/env bash
# install-systemd.sh — write the stavR systemd user-unit, print operator
# next-steps. CC builds the unit file; the operator runs `systemctl`.
#
# Per the os-native-governor BOM: the install script must NOT call
# systemctl itself. System-modifying actions (daemon-reload, enable,
# start) stay operator-run.
#
# Idempotent: re-running overwrites the unit file with freshly-resolved
# values. Operator should run `systemctl --user daemon-reload` after
# any re-install.

set -euo pipefail

# Resolve script directory and the project install root (script lives in bin/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Sanity checks before writing anything ---

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install-systemd.sh: this script is Linux-only. Detected: $(uname -s)" >&2
  echo "  - macOS: use bin/install-launchd.sh (Phase 2)" >&2
  echo "  - Windows: use bin/install-windows-service.ps1 (Phase 3)" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "install-systemd.sh: systemctl not found on PATH. systemd is required." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "install-systemd.sh: node not found on PATH. Install Node >= 20 first." >&2
  exit 1
fi

# Confirm the build artifact exists — the service will fail to start otherwise.
if [[ ! -f "$INSTALL_DIR/dist/cli.js" ]]; then
  echo "install-systemd.sh: $INSTALL_DIR/dist/cli.js not found." >&2
  echo "  Run 'npm run build' from $INSTALL_DIR first." >&2
  exit 1
fi

TEMPLATE="$SCRIPT_DIR/stavr.service.template"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-systemd.sh: template missing at $TEMPLATE" >&2
  exit 1
fi

# --- Resolve placeholders ---

STAVR_HOME="${STAVR_HOME:-$HOME/.stavr}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/stavr.service"

# Make sure the dirs the unit references exist before the unit tries to start.
mkdir -p "$UNIT_DIR"
mkdir -p "$STAVR_HOME"
mkdir -p "$INSTALL_DIR/tmp/diag-reports"

# --- Render the unit file ---

# `|` as the sed delimiter so paths with forward slashes don't escape. The
# PATH value can contain almost anything; we trust the operator's current
# PATH and reproduce it verbatim.
sed \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  -e "s|@INSTALL_DIR@|${INSTALL_DIR}|g" \
  -e "s|@STAVR_HOME@|${STAVR_HOME}|g" \
  -e "s|@HOME_DIR@|${HOME}|g" \
  -e "s|@PATH_VALUE@|${PATH}|g" \
  "$TEMPLATE" > "$UNIT_FILE"

chmod 644 "$UNIT_FILE"

# --- Refuse to confirm install if any @PLACEHOLDER@ survived (sed silently
#     leaves unmatched placeholders in place). ---

if grep -q '@[A-Z_]*@' "$UNIT_FILE"; then
  echo "install-systemd.sh: unsubstituted placeholders in $UNIT_FILE:" >&2
  grep -n '@[A-Z_]*@' "$UNIT_FILE" >&2
  exit 1
fi

# --- Operator next-steps ---

cat <<EOF
✓ Wrote ${UNIT_FILE}
  install dir: ${INSTALL_DIR}
  node:        ${NODE_BIN}
  STAVR_HOME:  ${STAVR_HOME}

Next steps (the install script does NOT run these — they modify your
system and are operator-owned):

  systemctl --user daemon-reload
  systemctl --user enable --now stavr.service

Verify:
  systemctl --user status stavr.service
  journalctl --user -u stavr.service -f
  curl -s http://127.0.0.1:7777/healthz

If you're on a headless host (no graphical login), the user-systemd
instance stops at logout unless lingering is enabled:
  sudo loginctl enable-linger \$USER

To uninstall:
  bin/uninstall-systemd.sh
EOF
