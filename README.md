# Dynland

A dynamic island for GNOME Shell 50 and 51 that replaces the top bar. The clock and the
idle indicators (by default Prayer Times) live in one pill that widens on hover into pages
of indicators; Quick Settings sits at the end of the second page. Notifications,
media, volume/brightness, battery and the prayer countdown split off into a bubble beside
the island, so the island stays usable. Every feature can be switched off in the preferences.

## Install

    ./scripts/install.sh

On Wayland, log out and back in so GNOME Shell loads the newly installed extension, then:

    gnome-extensions enable dynland@gawad-b.github.io

## Use

- Preferences: `gnome-extensions prefs dynland@gawad-b.github.io` (features, which
  indicators sit beside the clock and on the first page, style, shortcut).
- Press Super+B to expand or collapse the island (configurable in the preferences).
- Over the expanded island, scroll (or click the page dots) to reach the second page:
  Vitals, Apps, every other indicator and, at the end, Quick Settings.
- Hover or click the bubble to open the activity's card.
- The island lives on the primary monitor only.
- Panel items that have no status-area role (rare) are hidden while Dynland is enabled.

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

The nested window's frame clock stalls when it isn't on screen, which freezes every
animation. For anything timing-related run it headless instead:
`DYNLAND_HEADLESS=1 ./scripts/nested.sh` renders to a 1920x1080 virtual monitor with a
real frame clock. `tests/manual/test-window.js` opens a red window in it (pass the
shell's `WAYLAND_DISPLAY`) to maximise or fullscreen from `scripts/nested-eval.sh`;
`St.Settings.get().slow_down_factor = 10` slows animations enough to screenshot them.
