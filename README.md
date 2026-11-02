# Dynland

A dynamic island for GNOME Shell 50 and 51 that replaces the top bar. The clock, Quick
Settings, workspaces and every extension's indicators live in one pill that expands on
hover and morphs for notifications, media, volume/brightness, battery and prayer times.
Every feature can be switched off in the preferences.

## Install

    ./scripts/install.sh
    gnome-extensions enable dynland@gawad-b.github.io

On Wayland, log out and back in so GNOME Shell loads a newly installed extension.

## Develop

    GSETTINGS_BACKEND=memory gjs -m tests/run.js   # unit tests
    ./scripts/nested.sh                            # isolated nested shell
    scripts/in-nested.sh notify-send Hi            # talk to it

The prayer countdown needs the Prayer Times extension (prayer-times@gawad-b.github.io).

## Testing

`scripts/nested.sh` runs an isolated nested shell with its own settings, data and cache
(under `.nested/`), so the real session is never touched. It also loads
`tools/dynland-devtools@gawad-b.github.io`, which turns on unsafe mode for the Eval and
screenshot helper scripts. Never install that extension in a real session.
