#!/usr/bin/env bash
# uninstall-systemd.sh — remove the stavR systemd user-unit. CC removes
# the file; the operator stops + disables the unit and runs daemon-reload.
#
# Per the os-native-governor BOM: the uninstall script must NOT call
# systemctl itself. System-modifying actions stay operator-run.
#
# Usage:
#   bin/uninstall-systemd.sh           # prints the steps + exits without removing
#   bin/uninstall-systemd.sh --force   # removes the unit file (operator must
#                                      # have already stopped + disabled)
#
# Idempotent: re-running with --force when the file is already gone is a no-op.

set -euo pipefail

UNIT_FILE="$HOME/.config/systemd/user/stavr.service"

if [[ ! -f "$UNIT_FILE" ]]; then
  echo "uninstall-systemd.sh: no unit at ${UNIT_FILE} — nothing to do."
  exit 0
fi

FORCE="${1:-}"

if [[ "$FORCE" != "--force" ]]; then
  cat <<EOF
About to remove: ${UNIT_FILE}

Run these FIRST (we cannot for you):

  systemctl --user stop stavr.service
  systemctl --user disable stavr.service

Then re-run this script with --force to remove the unit file:

  $0 --force

After removal, run:

  systemctl --user daemon-reload

EOF
  exit 0
fi

rm "$UNIT_FILE"

cat <<EOF
✓ Removed ${UNIT_FILE}

Now finish the cleanup (operator-run, NOT this script):

  systemctl --user daemon-reload
  systemctl --user reset-failed stavr.service 2>/dev/null || true

EOF
