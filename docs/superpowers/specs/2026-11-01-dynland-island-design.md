# Dynland — Dynamic Island for GNOME Shell

**Date:** 2026-11-01
**Status:** Approved design, awaiting spec review
**Target:** GNOME Shell 50 and 51 (Wayland); developed and tested on GNOME 50.6, Fedora 44

## Goal

Replace the GNOME top bar with an iOS-style "dynamic island": a floating pill at the top
centre that keeps every function of the top bar (clock, calendar and notifications,
Quick Settings, other extensions' indicators, workspaces and Activities) and morphs to show
live events (notifications, media, volume/brightness, power, prayer times). Every feature
can be turned on or off in preferences.

## Non-goals (v1)

- Per-monitor islands (primary monitor only).
- Re-implementing Quick Settings, the calendar or any indicator — the real ones are reused.
- Lock-screen / unlock-dialog island (GNOME's own lock-screen bar is used there).

## Approach

A GNOME Shell extension, `dynland@gawad-b.github.io`, written in ESM GJS. `metadata.json`
declares `shell-version: ["50", "51"]`. Every private shell API the extension touches
(`Main.panel._addToPanelBox`, the panel boxes, `MessageTray.bannerBlocked`,
`OsdWindowManager.show`) is checked for before use; if one is missing on a newer shell, only
the feature that needs it turns off and the rest of the island keeps working.

`Main.panel` stays alive but hidden, so the shell and other extensions keep registering
indicators in `Main.panel.statusArea` as usual. The island re-parents the real indicator
actors (and the date menu, Quick Settings, Activities and workspace indicator) into its own
layout and returns them to their original parent and position on disable. Each indicator's
`PopupMenu` stays attached to its button, so menus open from the island unchanged.

Rejected alternatives:
- **Restyle `Main.panel` into a pill** — a single fixed-order row can't do the two-row
  expanded view or morphing live activities.
- **Rebuild everything** — loses other extensions' indicators.

## Components

```
dynland@gawad-b.github.io/
  extension.js          enable/disable; wires everything together
  island.js             Island actor: idle / expanded / activity states, morph animations
  panelBridge.js        hides Main.panel, borrows & restores indicators, watches statusArea
  activities/
    notifications.js    replaces MessageTray banners
    media.js            MPRIS players (org.mpris.MediaPlayer2.*)
    osd.js              replaces Main.osdWindowManager popups for volume/brightness
    power.js            UPower: plug/unplug, low battery
    prayer.js           next-prayer countdown from prayer-times' GSettings
  lib/activityManager.js  priority queue + timers (pure)
  lib/prayerCalc.js     prayer-time maths (pure)
  lib/layout.js         which indicators go in idle vs expanded (pure)
  lib/extensionSettings.js  opens another extension's GSettings (shell and prefs)
  prefs.js              Adw preferences window
  schemas/org.gnome.shell.extensions.dynland.gschema.xml
  stylesheet.css
tests/                  gjs -m unit tests for the pure modules
tests/manual/fake-mpris.js  fake media player for testing
scripts/                install.sh, nested.sh, in-nested.sh
```

### Activity interface

Every module in `activities/` exports a class with:

- `enable(manager)` / `disable()`
- calls `manager.request(id, priority, { compact, expanded, timeoutMs })` to show content
  and `manager.release(id)` to give it up.

`compact` and `expanded` are factory functions that return `St` actors. The manager shows
the highest-priority active request. A pre-empted request is paused and resumes when the
higher one ends (unless its own timeout expired meanwhile).

Priority (high → low): notification, OSD, power, prayer, media.

Each activity runs inside try/catch. If an activity throws, the manager disables it, logs
the error with `console.error`, and the island carries on.

## Island states

### Idle

- About 36 px tall, centred on the primary monitor, 6 px from the top, fully rounded,
  solid black by default.
- Left: the Activities button. In GNOME 50 it *is* the workspace dots (one actor), so one
  switch controls both. Clicking opens the overview; scrolling on the pill cycles workspaces.
- Centre: clock (click opens the real date menu: calendar and notification list).
- Right: indicators listed in the `idle-indicators` setting. The default is the Quick
  Settings button, which in GNOME 50 already holds the Wi-Fi, volume and battery icons.
  Clicking it opens the real Quick Settings menu.
- The width fits the visible items; any item can be turned off.

### Expanded

- Triggered by hovering about 300 ms, clicking an empty area of the pill, or the
  `toggle-shortcut` key (default `<Super>b`; `<Super>space` is GNOME's input-source switcher).
- About 640 px wide, two rows:
  - Row 1: Activities button (workspace dots), the clock, and the full date.
  - Row 2: every other indicator (Vitals, tray icons, clipboard, caffeine, prayer-times, …).
- Collapses about 600 ms after the pointer leaves, but never while one of its menus is open.

### Live activities

| Activity | Compact | Expanded (hover/click) | Duration |
|---|---|---|---|
| Notification | App icon + title | Card with body, action buttons; click opens the app; × or swipe up dismisses | 5 s, held while hovered; queued notifications show one after another |
| Media | Album art left, animated bars right, clock kept | Title, artist, ⏮ ⏯ ⏭, progress bar (display only; GNOME's MPRIS wrapper has no seek) | While playing; back to idle 10 s after pause |
| Volume / brightness | Icon + level bar | — | 1.5 s after the last change |
| Power | ⚡ + %, green when plugging in, red when low | — | 3 s; low warning at 10 % and 5 % |
| Prayer | Prayer name + countdown | Today's prayer list | From `prayer-lead-minutes` (default 15) before a prayer until it starts |

- When Do Not Disturb (`org.gnome.desktop.notifications show-banners = false`) is on,
  notifications don't take over the island; they still go to the date-menu list.
- Animations: about 350 ms with a spring-like ease. They respect GNOME's
  `enable-animations` setting and Dynland's `reduce-motion` switch.

## Settings (GSettings `org.gnome.shell.extensions.dynland`)

| Key | Type | Default |
|---|---|---|
| `show-clock`, `show-quick-settings`, `show-activities`, `show-tray-indicators` | b | true |
| `activity-notifications`, `activity-media`, `activity-osd`, `activity-power`, `activity-prayer` | b | true |
| `idle-indicators` | as | `['quickSettings']` (keys are `Main.panel.statusArea` names) |
| `reserve-space` | b | true (maximised windows sit below the island) |
| `style` | s | `'solid'` (`'solid'` or `'blur'`) |
| `reduce-motion` | b | false |
| `prayer-lead-minutes` | i | 15 |
| `toggle-shortcut` | as | `['<Super>b']` |
| `debug-fake-prayer-minutes` | i | -1 (testing only, not in prefs: pretend the next prayer is N minutes after enable) |

When an activity is turned off, GNOME's default behaviour comes back: notifications use
the standard banner, and volume/brightness use the standard OSD popup.

`prefs.js` is an Adw window with three pages:
- **Top bar:** the `show-*` keys, the idle-indicator list, reserve space, style.
- **Live activities:** the `activity-*` keys and the prayer lead time.
- **Advanced:** shortcut, reduce motion, and conflict warnings.

## Integration details

- **Hiding the panel:** hide `Main.layoutManager.panelBox`; nothing is destroyed. The island
  is added with `addTopChrome(island, {affectsStruts: false, trackFullscreen: true})` so its
  morphing never resizes windows. When `reserve-space` is on, a separate invisible,
  non-reactive 48 px band is added with `affectsStruts: true`.
- **Styling:** the island's rows are named `panel`, so GNOME's and other extensions'
  `#panel …` CSS applies to the borrowed indicators unchanged.
- **Borrowing indicators:** for each `statusArea` entry, remember its original parent and
  index, then reparent `indicator.container` into an island box. Indicators added later are
  picked up by wrapping `Main.panel._addToPanelBox` (an instance override, removed on
  disable), which schedules a re-layout: restore everything, then lend it out again.
  On disable, restore them in reverse order.
- **Notifications:** listen to each source's `notification-request-banner` and apply the
  same filters as GNOME (acknowledged, low urgency, per-app banner policy, which also
  covers Do Not Disturb). GNOME's own banner is suppressed by keeping
  `MessageTray.bannerBlocked` true. GNOME also sets that flag when the calendar opens,
  so an instance accessor stores the calendar's wish separately, and the island shows
  nothing while the calendar is open. A notification counts as seen
  (`acknowledged = true`) once the island finishes showing it. On disable, GNOME's banner
  shows any notifications still waiting.
- **OSD:** instance overrides of `Main.osdWindowManager.show` and `showAll` (which
  `showOne` also reaches). Only `audio-volume-*` and `display-brightness-*` icons go to the
  island; everything else, and any failure, falls through to GNOME's popup.
- **Media:** reuse GNOME's `MprisSource` from `ui/mpris.js`. The most recently started
  player wins. The progress bar polls the player's `Position` and `mpris:length` once a
  second while expanded.
- **Power:** use the UPower display device (`org.freedesktop.UPower`).
- **Prayer:** read latitude, longitude, calculation method, madhab and high-latitude rule
  from `org.gnome.shell.extensions.prayer-times`, loading that schema from the prayer-times
  extension's `schemas/` dir. `lib/prayerCalc.js` computes the times itself (praytimes.org
  algorithm with adhan's method parameters); it is tested to within 2 minutes of the
  prayer-times extension's own adhan results for every method except
  MoonsightingCommittee, whose seasonal rules are only approximated. If the extension
  isn't installed, the activity is unavailable and greyed out in prefs.

## Compatibility

- **Just Perfection:** prefs warns if its panel visibility or position options are active.
- **Blur My Shell:** it doesn't touch the island; Dynland offers its own `blur` style.
- **Dash-to-Dock, Search Light, Desk Widgets:** no conflict expected.
- **Prayer Times:** you can turn off its own panel label to avoid a duplicate.
- **Overview:** the island stays visible. **Lock screen:** the island is hidden.
  **Fullscreen windows:** the island hides.

## Disable guarantee

`disable()` restores every borrowed indicator to its original parent and index, puts back
`Main.panel`'s size, opacity and reactivity, removes the message-tray and OSD hooks,
disconnects every signal and destroys the island. After disable, the shell is
indistinguishable from before enable.

## Testing

- **Unit tests** (`gjs -m tests/run.js`), for the pure modules:
  - `activityManager`: priority, pre-emption, resume, timeouts.
  - `prayerCalc`: against known prayer times.
  - `layout`: the idle/expanded split.
- **Nested shell:** `scripts/nested.sh` runs `gnome-shell --devkit --wayland` (mutter-devkit
  50.6 is installed) under `dbus-run-session` with its own `XDG_CONFIG_HOME`, so enabling
  Dynland there never touches the real session's settings. It refuses to start with less than
  1.2 GB of RAM available or while another nested shell runs. `scripts/in-nested.sh` runs a
  command (gsettings, notify-send) against the nested shell.
- **Event triggers:**
  - `notify-send` for notifications
  - `tests/manual/fake-mpris.js` for media (mpv has no MPRIS plugin installed)
  - volume keys for the OSD
  - `debug-fake-prayer-minutes` for the countdown

  Plug and unplug the charger for power events.
- **Disable test:** enable, disable and re-enable, then confirm every indicator is back
  in the panel in its original order.
- **Last step:** enable in the real session once the nested-shell tests pass.
