#!/usr/bin/env bash
# Runs GNOME Shell in a nested window with Dynland enabled. The nested shell
# gets its own settings folder, so the real session's enabled extensions and
# Dynland settings are never touched. Your other currently enabled extensions
# are enabled in the nested shell too, to test them alongside the island.
# A dev-tools extension (loaded only here, from .nested/data) turns on unsafe
# mode so scripts/nested-eval.sh and scripts/nested-shot.sh work.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
uuid=dynland@gawad-b.github.io
devtools=dynland-devtools@gawad-b.github.io

avail=$(free -m | awk '/^Mem:/ {print $7}')
if (( avail < 1200 )); then
    echo "Only ${avail} MB RAM available; the nested shell needs about 1.2 GB. Close something first." >&2
    exit 1
fi
if pgrep -f '^gnome-shell --devkit' >/dev/null; then
    echo "A nested shell is already running." >&2
    exit 1
fi

host_extensions=$(gsettings get org.gnome.shell enabled-extensions)
state="$root/.nested"            # on disk, not /tmp (RAM disk)
mkdir -p "$state/config" "$state/data/gnome-shell/extensions" "$state/shots"
ln -sfn "$root/tools/$devtools" "$state/data/gnome-shell/extensions/$devtools"
rm -f "$state/bus"

export XDG_CONFIG_HOME="$state/config"
export XDG_DATA_DIRS="$state/data:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export DYNLAND_STATE="$state" DYNLAND_HOST_EXTENSIONS="$host_extensions"
export DYNLAND_EXTRA="$uuid $devtools"

exec dbus-run-session -- bash -c '
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$DYNLAND_STATE/bus"
    list=$(python3 -c "
import ast, os
l = ast.literal_eval(os.environ[\"DYNLAND_HOST_EXTENSIONS\"].removeprefix(\"@as \"))
for u in os.environ[\"DYNLAND_EXTRA\"].split():
    if u not in l:
        l.append(u)
print(repr(l))")
    gsettings set org.gnome.shell enabled-extensions "$list"
    gsettings set org.gnome.shell disable-user-extensions false
    gnome-shell --devkit --wayland > "$DYNLAND_STATE/shell.log" 2>&1
'
