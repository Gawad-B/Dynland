#!/usr/bin/env bash
# Links this checkout into the user's extensions folder and compiles the
# settings schema. Does not enable the extension.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
uuid=dynland@gawad-b.github.io
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

glib-compile-schemas --strict "$root/schemas"
mkdir -p "$(dirname "$target")"
if [[ -e "$target" && ! -L "$target" ]]; then
    echo "$target exists and is not a symlink; remove it first." >&2
    exit 1
fi
ln -sfn "$root" "$target"
echo "Linked $target -> $root"
