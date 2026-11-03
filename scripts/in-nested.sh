#!/usr/bin/env bash
# Runs a command against the nested shell started by scripts/nested.sh,
# e.g.:  scripts/in-nested.sh notify-send "Hello" "From the island"
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ ! -f "$root/.nested/bus" ]] || ! pgrep -f '^gnome-shell --(devkit|headless)' >/dev/null; then
    echo "No nested shell running; start scripts/nested.sh first." >&2
    exit 1
fi
DBUS_SESSION_BUS_ADDRESS=$(cat "$root/.nested/bus") XDG_CONFIG_HOME="$root/.nested/config" exec "$@"
