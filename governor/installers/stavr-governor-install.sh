#!/usr/bin/env bash
# stavR Governor — macOS / Linux autostart installer
#
# Configures the Governor to launch at user login.
#   - macOS:  LaunchAgent (~/Library/LaunchAgents/tech.stavr.governor.plist)
#   - Linux:  systemd --user unit (~/.config/systemd/user/stavr-governor.service)
#
# Idempotent — re-running rewrites the same file. `--uninstall` removes it
# and (on macOS) unloads the agent, (on Linux) disables the unit.
#
# Pairs with `governor/scripts/install-from-release.sh` (download + verify
# + stage the binary). This script is the autostart wiring only.
#
# Usage:
#   ./stavr-governor-install.sh                                  # default binary path
#   ./stavr-governor-install.sh --binary /path/to/stavr-governor
#   ./stavr-governor-install.sh --dashboard-base http://127.0.0.1:7778
#   ./stavr-governor-install.sh --log-path /var/log/stavr/daemon.out.log
#   ./stavr-governor-install.sh --uninstall

set -euo pipefail

BINARY="${HOME}/.stavr/governor/stavr-governor"
DASHBOARD_BASE=""
LOG_PATH=""
DO_UNINSTALL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --binary)
            BINARY="$2"; shift 2 ;;
        --dashboard-base)
            DASHBOARD_BASE="$2"; shift 2 ;;
        --log-path)
            LOG_PATH="$2"; shift 2 ;;
        --uninstall)
            DO_UNINSTALL=1; shift ;;
        -h|--help)
            sed -n '2,/^set/p' "$0" | sed 's/^# \{0,1\}//' | head -n -2
            exit 0 ;;
        *)
            echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

OS="$(uname -s)"

case "$OS" in
    Darwin)
        PLIST="${HOME}/Library/LaunchAgents/tech.stavr.governor.plist"
        if [[ $DO_UNINSTALL -eq 1 ]]; then
            echo "→ macOS: removing LaunchAgent"
            if [[ -f "$PLIST" ]]; then
                launchctl unload "$PLIST" 2>/dev/null || true
                rm -f "$PLIST"
                echo "  removed: $PLIST"
            else
                echo "  no plist found (already uninstalled)"
            fi
            echo "Done. Governor will not auto-launch on next login."
            echo "Note: this does not stop a running Governor. If ᚱ is in the menu bar,"
            echo "      click it → Quit Governor."
            exit 0
        fi

        if [[ ! -x "$BINARY" ]]; then
            echo "Binary not found or not executable at $BINARY" >&2
            echo "Run install-from-release.sh first or pass --binary <path>." >&2
            exit 1
        fi

        mkdir -p "$(dirname "$PLIST")"
        # Build EnvironmentVariables block. macOS plists are XML; we keep
        # the formatting tight and only emit env keys the operator opted in to.
        ENV_BLOCK=""
        if [[ -n "$DASHBOARD_BASE" ]]; then
            ENV_BLOCK+="        <key>STAVR_DASHBOARD_BASE</key>\n        <string>${DASHBOARD_BASE}</string>\n"
        fi
        if [[ -n "$LOG_PATH" ]]; then
            ENV_BLOCK+="        <key>STAVR_LOG_PATH</key>\n        <string>${LOG_PATH}</string>\n"
        fi

        ENV_DICT=""
        if [[ -n "$ENV_BLOCK" ]]; then
            ENV_DICT="    <key>EnvironmentVariables</key>\n    <dict>\n${ENV_BLOCK}    </dict>\n"
        fi

        cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>tech.stavr.governor</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BINARY}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
$(printf '%b' "$ENV_DICT")    <key>StandardOutPath</key>
    <string>${HOME}/.stavr/governor/governor.out.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.stavr/governor/governor.err.log</string>
</dict>
</plist>
PLISTEOF

        echo "→ macOS: wrote $PLIST"
        # Reload so the change takes effect immediately.
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST"
        echo "  loaded via launchctl — Governor should now be running"
        echo
        echo "Verify:  ls -la \"$PLIST\"  &&  launchctl list | grep tech.stavr.governor"
        ;;

    Linux)
        UNIT="${HOME}/.config/systemd/user/stavr-governor.service"
        if [[ $DO_UNINSTALL -eq 1 ]]; then
            echo "→ Linux: disabling systemd-user unit"
            if [[ -f "$UNIT" ]]; then
                systemctl --user stop stavr-governor.service 2>/dev/null || true
                systemctl --user disable stavr-governor.service 2>/dev/null || true
                rm -f "$UNIT"
                systemctl --user daemon-reload || true
                echo "  removed: $UNIT"
            else
                echo "  no unit found (already uninstalled)"
            fi
            echo "Done."
            exit 0
        fi

        if [[ ! -x "$BINARY" ]]; then
            echo "Binary not found or not executable at $BINARY" >&2
            echo "Run install-from-release.sh first or pass --binary <path>." >&2
            exit 1
        fi

        mkdir -p "$(dirname "$UNIT")"
        ENV_LINES=""
        if [[ -n "$DASHBOARD_BASE" ]]; then
            ENV_LINES+="Environment=STAVR_DASHBOARD_BASE=${DASHBOARD_BASE}\n"
        fi
        if [[ -n "$LOG_PATH" ]]; then
            ENV_LINES+="Environment=STAVR_LOG_PATH=${LOG_PATH}\n"
        fi

        cat > "$UNIT" <<UNITEOF
[Unit]
Description=stavR Governor — tray companion supervising the stavR daemon
After=graphical-session.target

[Service]
ExecStart=${BINARY}
Restart=on-failure
RestartSec=3s
$(printf '%b' "$ENV_LINES")
[Install]
WantedBy=default.target
UNITEOF

        echo "→ Linux: wrote $UNIT"
        systemctl --user daemon-reload
        systemctl --user enable stavr-governor.service
        systemctl --user restart stavr-governor.service
        echo "  enabled + (re)started via systemctl --user"
        echo
        echo "Verify:  systemctl --user status stavr-governor"
        echo "Logs:    journalctl --user -u stavr-governor -f"
        echo
        echo "Note: on a fresh Linux user account systemd-user may need lingering"
        echo "      enabled to run before login. Check with: loginctl show-user \$USER --property=Linger"
        echo "      Enable: sudo loginctl enable-linger \$USER"
        ;;

    *)
        echo "Unsupported OS: $OS. This installer handles Darwin (macOS) and Linux." >&2
        echo "For Windows, run governor/installers/stavr-governor-install.ps1 from PowerShell." >&2
        exit 1 ;;
esac

echo
echo "Optional next steps:"
echo "  - To uninstall: $0 --uninstall"
echo "  - Quit Governor from the tray UI (right-click ᚱ → Quit Governor); does not stop the daemon."
