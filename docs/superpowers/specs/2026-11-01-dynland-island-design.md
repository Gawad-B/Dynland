# Dynland — Dynamic Island for GNOME Shell

**Date:** 2026-11-01
**Status:** Approved design, awaiting spec review
**Target:** GNOME Shell 50 (Wayland), Fedora 44

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

A GNOME Shell extension, `dynland@gawad-b.github.io`, written in ESM GJS.

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
  activityManager.js    priority queue + timers; decides what the island shows (pure logic)
  activities/
    notifications.js    replaces MessageTray banners
    media.js            MPRIS players (org.mpris.MediaPlayer2.*)
    osd.js              replaces Main.osdWindowManager popups for volume/brightness
    power.js            UPower: plug/unplug, low battery
    prayer.js           next-prayer countdown from prayer-times' GSettings
  lib/prayerCalc.js     prayer-time maths (pure)
  lib/layout.js         which indicators go in idle vs expanded (pure)
  prefs.js              Adw preferences window
  schemas/org.gnome.shell.extensions.dynland.gschema.xml
  stylesheet.css
tests/                  gjs -m unit tests for the pure modules
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
- Left: workspace dots (click switches workspace; scrolling on the pill cycles workspaces).
- Centre: clock (click opens the real date menu: calendar and notification list).
- Right: indicators listed in the `idle-indicators` setting. The default is the Quick
  Settings button, which in GNOME 50 already holds the Wi-Fi, volume and battery icons.
  Clicking it opens the real Quick Settings menu.
- The width fits the visible items; any item can be turned off.

### Expanded

- Triggered by hovering about 300 ms, clicking an empty area of the pill, or the
  `toggle-shortcut` key (default `<Super>space`).
- About 640 px wide, two rows:
  - Row 1: Activities button, workspace dots, full date and time.
  - Row 2: every other indicator (Vitals, tray icons, clipboard, caffeine, prayer-times, …).
- Collapses about 600 ms after the pointer leaves, but never while one of its menus is open.

### Live activities

| Activity | Compact | Expanded (hover/click) | Duration |
|---|---|---|---|
| Notification | App icon + title | Card with body, action buttons; click opens the app; × or swipe up dismisses | 5 s, held while hovered; queued notifications show one after another |
| Media | Album art left, animated bars right, clock kept | Title, artist, ⏮ ⏯ ⏭, seek bar | While playing; back to idle 10 s after pause |
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
| `show-clock`, `show-quick-settings`, `show-workspaces`, `show-activities`, `show-tray-indicators` | b | true |
| `activity-notifications`, `activity-media`, `activity-osd`, `activity-power`, `activity-prayer` | b | true |
| `idle-indicators` | as | `['quickSettings']` (keys are `Main.panel.statusArea` names) |
| `reserve-space` | b | true (maximised windows sit below the island) |
| `style` | s | `'solid'` (`'solid'` or `'blur'`) |
| `reduce-motion` | b | false |
| `prayer-lead-minutes` | i | 15 |
| `toggle-shortcut` | as | `['<Super>space']` |

When an activity is turned off, GNOME's default behaviour comes back: notifications use
the standard banner, and volume/brightness use the standard OSD popup.

`prefs.js` is an Adw window with three pages:
- **Top bar:** the `show-*` keys, the idle-indicator list, reserve space, style.
- **Live activities:** the `activity-*` keys and the prayer lead time.
- **Advanced:** shortcut, reduce motion, and conflict warnings.

## Integration details

- **Hiding the panel:** set `Main.panel` height to 0 and opacity to 0, and make it
  non-reactive; the actor is never destroyed. The island is added with
  `Main.layoutManager.addTopChrome(island, { affectsStruts: reserveSpace, trackFullscreen: true })`.
- **Borrowing indicators:** for each `statusArea` entry, remember its original parent and
  index, then reparent `indicator.container` into an island box. Connect to `statusArea`
  changes (wrapping `Main.panel.addToStatusArea`) so indicators added later are picked up.
  On disable, restore them in reverse order.
- **Notifications:** hook `Main.messageTray` so the island draws the banner instead of
  `_bannerBin`. Restore the original methods on disable.
- **OSD:** wrap `Main.osdWindowManager.show` and forward the call when `activity-osd` is off.
- **Media:** watch the session bus for `org.mpris.MediaPlayer2.*` names. The most recently
  playing player wins.
- **Power:** use the UPower display device (`org.freedesktop.UPower`).
- **Prayer:** read location and calculation method from
  `org.gnome.shell.extensions.prayer-times`, loading that schema from the prayer-times
  extension's `schemas/` dir. If it isn't installed, the prayer activity is unavailable and
  greyed out in prefs.

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
- **Nested shell:** `dbus-run-session gnome-shell --devkit --wayland`, with the extension
  installed by symlink. Needs `mutter-devkit`; check before installing. It uses about
  0.5–1 GB of RAM, so check `free -h` first and run one at a time.
- **Event triggers:**
  - `notify-send` for notifications
  - `mpv` for media
  - volume keys for the OSD
  - a test prayer time set in prefs for the countdown

  Plug and unplug the charger for power events.
- **Disable test:** enable, disable and re-enable, then confirm every indicator is back
  in the panel in its original order.
- **Last step:** enable in the real session once the nested-shell tests pass.
