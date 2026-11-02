#!/usr/bin/env bash
# Screenshots the nested shell. Prints the PNG path.
#   scripts/nested-shot.sh island-idle
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-shot}
path="$root/.nested/shots/$name.png"
"$root/scripts/in-nested.sh" gdbus call --session --dest org.gnome.Shell.Screenshot \
    --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot \
    false false "$path" >/dev/null
echo "$path"
