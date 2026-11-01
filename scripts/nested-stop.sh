#!/usr/bin/env bash
# Stops the nested shell started by scripts/nested.sh.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
pkill -f '^gnome-shell --devkit' || true
for _ in $(seq 20); do
    pgrep -f '^gnome-shell --devkit' >/dev/null || break
    sleep 0.5
done
rm -f "$root/.nested/bus"
