#!/usr/bin/env bash
# Runs GNOME Shell in a nested window with Dynland enabled. With
# DYNLAND_HEADLESS=1 it runs headless on a 1920x1080 virtual monitor instead:
# nothing appears on screen and the frame clock never stalls, so animations run
# at real speed and screenshots catch them mid-flight. The nested shell
# gets its own config, data and cache folders under .nested/, so the real
# session's settings, extension data and caches are never written. Your other
# currently enabled extensions are enabled in the nested shell too, to test
# them alongside the island. Extension folders are symlinked from your real
# extensions folder, so an extension that writes inside its own install folder
# still writes the real one. The Dynland checkout itself is linked in as the
# extension, so no install step is needed. A dev-tools extension (loaded only
# here) turns on unsafe mode so scripts/nested-eval.sh and scripts/nested-shot.sh
# work.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
uuid=dynland@gawad-b.github.io
devtools=dynland-devtools@gawad-b.github.io

avail=$(free -m | awk '/^Mem:/ {print $7}')
if (( avail < 1200 )); then
    echo "Only ${avail} MB RAM available; the nested shell needs about 1.2 GB. Close something first." >&2
    exit 1
fi
if pgrep -f '^gnome-shell --(devkit|headless)' >/dev/null; then
    echo "A nested shell is already running." >&2
    exit 1
fi

glib-compile-schemas --strict "$root/schemas"

host_extensions=$(gsettings get org.gnome.shell enabled-extensions)
real_extensions="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"  # read before XDG_DATA_HOME is changed
state="$root/.nested"            # on disk, not /tmp (RAM disk)
data_home="$state/data-home"
ext_dir="$data_home/gnome-shell/extensions"
mkdir -p "$state/config" "$state/cache" "$ext_dir" "$state/shots"
rm -f "$state/bus"

# Symlink every real user extension by name, so the nested shell sees the same
# set. Stale links are removed first so extensions you have since removed
# disappear here too. Only symlinks are deleted, never real folders.
find "$ext_dir" -maxdepth 1 -type l -delete
shopt -s nullglob
for entry in "$real_extensions"/*; do
    name=$(basename "$entry")
    [[ $name == "$uuid" ]] && continue
    ln -sfn "$entry" "$ext_dir/$name"
done
shopt -u nullglob
ln -sfn "$root" "$ext_dir/$uuid"
ln -sfn "$root/tools/$devtools" "$ext_dir/$devtools"

export XDG_CONFIG_HOME="$state/config"
export XDG_DATA_HOME="$data_home"
export XDG_CACHE_HOME="$state/cache"
export DYNLAND_STATE="$state" DYNLAND_HOST_EXTENSIONS="$host_extensions"
export DYNLAND_EXTRA="$uuid $devtools"
if [[ ${DYNLAND_HEADLESS:-} == 1 ]]; then
    export DYNLAND_SHELL_ARGS="--headless --virtual-monitor 1920x1080 --wayland --no-x11"
else
    export DYNLAND_SHELL_ARGS="--devkit --wayland"
fi

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
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '"'"'99.0'"'"'
    gnome-shell $DYNLAND_SHELL_ARGS > "$DYNLAND_STATE/shell.log" 2>&1
'
