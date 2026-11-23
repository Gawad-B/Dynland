# Dynland

A dynamic island for GNOME Shell 50 and 51 that replaces the top bar. The clock and the
idle indicators (by default Prayer Times) live in one pill that widens on hover into pages
of indicators; Quick Settings sits at the end of the second page. Notifications,
media, volume/brightness, battery and the prayer countdown split off into a bubble beside
the island, so the island stays usable. Every feature can be switched off in the preferences.

## Install

    git clone https://github.com/Gawad-B/Dynland.git
    cd Dynland
    make install

Then log out and back in. `make install` also enables the extension, so there is
nothing else to do, and it installs a copy: you can delete the clone afterwards.

It needs `make` and `glib-compile-schemas` (Fedora: `glib2`; Debian/Ubuntu:
`libglib2.0-bin`).

To share it without git, `make package` builds `build/dynland@gawad-b.github.io.zip`;
on the other machine run `gnome-extensions install --force <zip>`, then log out and in
and `gnome-extensions enable dynland@gawad-b.github.io`.

`make uninstall` removes it. For development, `make link` links this checkout
instead of copying it, so edits apply on the next shell restart.

## Use

- Preferences: `gnome-extensions prefs dynland@gawad-b.github.io` (features, which
  indicators sit beside the clock and on the first page, style, shortcut).
- Press Super+B to expand or collapse the island (configurable in the preferences).
- Over the expanded island, scroll (or click the page dots) to reach the second page:
  Vitals, Apps, every other indicator and, at the end, Quick Settings.
- Hover or click the bubble to open the activity's card.
- With "Keep windows below the island" off, the island hides while a window covers it
  (like Dash to Dock's intellihide); push the pointer to the top edge to bring it back.
  Turn "Hide while a window covers the island" off instead to keep it on screen as an
  empty black pill that opens on hover. Either way, while the island or Dash to Dock's
  dock is shown over a window, Dynland keeps the compositor drawing (as GNOME's menus
  do), since Mutter would otherwise put a window that fills the monitor straight onto the
  display and leave the island, the dock and menus invisible.
- Preferences > Layout switches to "MacBook bar": a full-width translucent bar like the macOS
  menu bar, with the notch in its middle, the focused app's name and menu on the left, and
  status icons and the clock on the right. Windows start right below it. "Notch opens on
  hover" chooses whether the notch still shows the indicator pages or stays empty.
  Three lists in the "MacBook bar" group of the preferences choose which indicators sit on
  the left after the app name, which Quick Settings items (network, volume, battery, ...)
  show on the bar beside the control-centre icon, and which show as an icon without text.
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
