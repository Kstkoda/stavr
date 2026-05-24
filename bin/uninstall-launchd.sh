#!/usr/bin/env bash
# uninstall-launchd.sh — remove the stavR LaunchAgent plist. CC removes
# the file; the operator runs `launchctl bootout`.
#
# Per the os-native-governor BOM: the uninstall script must NOT call
# launchctl itself. System-modifying actions stay operator-run.
#
# Usage:
#   bin/uninstall-launchd.sh           # prints the steps + exits without removing
#   bin/uninstall-launchd.sh --force   # removes the plist (operator must have
#                                      # already booted-out the service)
#
# Idempotent: re-running with --force when the file is already gone is a no-op.

set -euo pipefail

PLIST_FILE="$HOME/Library/LaunchAgents/com.stavr.daemon.plist"

if [[ ! -f "$PLIST_FILE" ]]; then
  echo "uninstall-launchd.sh: no plist at ${PLIST_FILE} — nothing to do."
  exit 0
fi

FORCE="${1:-}"

UID_NUM="$(id -u)"

if [[ "$FORCE" != "--force" ]]; then
  cat <<EOF
About to remove: ${PLIST_FILE}

Run this FIRST (we cannot for you — the bootout requires the actual
service-manager call):

  launchctl bootout gui/${UID_NUM} ${PLIST_FILE}

Then re-run this script with --force to remove the plist file:

  $0 --force

EOF
  exit 0
fi

rm "$PLIST_FILE"

cat <<EOF
✓ Removed ${PLIST_FILE}

If the agent was still loaded when --force ran, the running instance
will continue until the next bootout / reboot. Confirm it's gone:

  launchctl print gui/${UID_NUM}/com.stavr.daemon 2>&1 | head -3
  # expect: "Could not find service ..."

EOF
