# Dynland Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dynland@gawad-b.github.io`, a GNOME Shell 50/51 extension that replaces the top bar with a dynamic island which keeps every top-bar function and morphs for notifications, media, volume/brightness, power and prayer times, with a switch for each feature.

**Architecture:** GNOME's `Main.panel` stays alive but hidden; `PanelBridge` lends its real indicator actors to the `Island` actor and returns them on disable. Live events are small activity modules that ask a pure `ActivityManager` (priority queue + timers) to show content; the island renders whatever the manager says is current. Everything that doesn't need the shell (`lib/`) is unit-tested with `gjs -m`; shell-facing code is verified in a nested GNOME Shell with isolated settings.

**Tech Stack:** GJS 1.88 (ESM), GNOME Shell 50.6 / Mutter 50 (St, Clutter, Meta, Shell), libadwaita prefs, GSettings, D-Bus (MPRIS, UPower).

**Spec:** `docs/superpowers/specs/2026-11-01-dynland-island-design.md`

## Global Constraints

- UUID `dynland@gawad-b.github.io`; settings schema `org.gnome.shell.extensions.dynland`; `shell-version: ["50", "51"]`.
- ESM only: `import X from 'gi://X'` and `resource:///org/gnome/shell/...`; no `imports.*`, no `ExtensionUtils`.
- Code style matches GNOME Shell: 4-space indent, single quotes, `connectObject`/`disconnectObject` for signals, `Clutter.Orientation.VERTICAL` (not `vertical: true`).
- Every private shell API (`Main.panel._addToPanelBox`, panel `_leftBox/_centerBox/_rightBox`, the `MessageTray.bannerBlocked` setter, `OsdWindowManager.show/showAll`) is checked before use; if missing, throw from that component's `enable()` so only that feature turns off.
- `disable()` must leave the shell exactly as before `enable()`. Borrowed indicators are restored **before** the island is destroyed.
- Priority order: notification 50, OSD 40, power 30, prayer 20, media 10.
- Timings: hover-expand 300 ms; leave-collapse 600 ms (never while a borrowed menu is open); morph 350 ms `EASE_OUT_BACK`; notification 5 s (critical: no timeout); OSD 1.5 s; power 3 s; media lingers 10 s after pause; prayer lead default 15 min.
- Default shortcut `<Super>b` (`<Super>space` is GNOME's input-source switcher).
- **Machine limits (7.4 GB RAM, `/tmp` is a RAM disk):** check `free -h` before starting a nested shell; one nested shell at a time; `.nested/` state lives on disk inside the repo, never in `/tmp`; stop the nested shell when a task's checks are done.
- Never enable Dynland in the real session before Task 13 Step 5; all shell testing happens in `scripts/nested.sh`, whose settings are isolated from the real session.
- Nested-shell checks are done by agents: `scripts/nested-eval.sh` (org.gnome.Shell.Eval) and `scripts/nested-shot.sh` (screenshot PNG to Read). They work because `tools/dynland-devtools@gawad-b.github.io` turns on unsafe mode; it is loaded only by `nested.sh` from `.nested/data` and must never be installed in the real session. Never kill processes by a pattern that could match the real `gnome-shell`; stop the nested shell only with `scripts/nested-stop.sh`.

## File Map

| File | Responsibility |
|---|---|
| `metadata.json` | Extension identity, supported shells |
| `schemas/org.gnome.shell.extensions.dynland.gschema.xml` | All settings |
| `lib/layout.js` | Pure: which indicator goes in which island slot |
| `lib/activityManager.js` | Pure: activity priority, pre-emption, timeouts, error guard |
| `lib/prayerCalc.js` | Pure: prayer-time maths |
| `lib/extensionSettings.js` | Open another extension's GSettings (shell and prefs) |
| `island.js` | The pill actor: idle / expanded / activity, morph, hover, click, scroll |
| `panelBridge.js` | Hide GNOME's bar, lend and return indicators |
| `activities/{notifications,osd,power,media,prayer}.js` | One live event each |
| `extension.js` | Wiring: settings, strut, activities on/off, shortcut |
| `prefs.js` | Adwaita preferences |
| `stylesheet.css` | Island styles |
| `tests/*.test.js`, `tests/harness.js`, `tests/run.js`, `tests/fakeTimers.js` | Unit tests |
| `tests/manual/fake-mpris.js` | Fake media player for manual tests |
| `scripts/install.sh`, `scripts/nested.sh`, `scripts/in-nested.sh` | Install link, isolated nested shell, run commands in it |
| `scripts/nested-eval.sh`, `scripts/nested-shot.sh`, `scripts/nested-stop.sh`, `tools/dynland-devtools@gawad-b.github.io/` | Inspect, screenshot and stop the nested shell (agent verification) |

Unit tests always run as `GSETTINGS_BACKEND=memory gjs -m tests/run.js` (the memory backend keeps tests away from real settings).

---

### Task 1: Scaffold, settings schema, test harness and dev scripts

**Files:**
- Create: `metadata.json`, `schemas/org.gnome.shell.extensions.dynland.gschema.xml`, `.gitignore`
- Create: `tests/harness.js`, `tests/run.js`
- Create: `scripts/install.sh`, `scripts/nested.sh`, `scripts/in-nested.sh`, `scripts/nested-eval.sh`, `scripts/nested-shot.sh`, `scripts/nested-stop.sh`
- Create: `tools/dynland-devtools@gawad-b.github.io/metadata.json`, `tools/dynland-devtools@gawad-b.github.io/extension.js`

**Interfaces:**
- Produces: `test(name, fn)`, `assert(cond, msg)`, `assertEqual(actual, expected, msg)`, `runAll() → Promise<number of failures>` from `tests/harness.js`; every settings key used by later tasks.

- [ ] **Step 1: Create `metadata.json`**

```json
{
  "uuid": "dynland@gawad-b.github.io",
  "name": "Dynland",
  "description": "A dynamic island that replaces the top bar: clock, Quick Settings, workspaces and every extension's indicators in one pill that morphs for notifications, media, volume/brightness, battery and prayer times.",
  "shell-version": ["50", "51"],
  "settings-schema": "org.gnome.shell.extensions.dynland",
  "url": "https://github.com/Gawad-B/Dynland",
  "version": 1
}
```

- [ ] **Step 2: Create `schemas/org.gnome.shell.extensions.dynland.gschema.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.dynland"
          path="/org/gnome/shell/extensions/dynland/">

    <!-- Top-bar functions -->
    <key name="show-clock" type="b">
      <default>true</default>
      <summary>Show the clock (opens calendar and notifications)</summary>
    </key>
    <key name="show-quick-settings" type="b">
      <default>true</default>
      <summary>Show Quick Settings (Wi-Fi, volume, battery, power)</summary>
    </key>
    <key name="show-activities" type="b">
      <default>true</default>
      <summary>Show the Activities button with workspace dots</summary>
    </key>
    <key name="show-tray-indicators" type="b">
      <default>true</default>
      <summary>Show other indicators (extensions, tray icons) when expanded</summary>
    </key>
    <key name="idle-indicators" type="as">
      <default>['quickSettings']</default>
      <summary>Indicators shown in the idle pill</summary>
      <description>Main.panel.statusArea role names, e.g. 'quickSettings' or 'vitalsMenu'.</description>
    </key>

    <!-- Live activities -->
    <key name="activity-notifications" type="b">
      <default>true</default>
      <summary>Show notifications in the island</summary>
    </key>
    <key name="activity-media" type="b">
      <default>true</default>
      <summary>Show playing media in the island</summary>
    </key>
    <key name="activity-osd" type="b">
      <default>true</default>
      <summary>Show volume and brightness changes in the island</summary>
    </key>
    <key name="activity-power" type="b">
      <default>true</default>
      <summary>Show charging and low-battery events in the island</summary>
    </key>
    <key name="activity-prayer" type="b">
      <default>true</default>
      <summary>Show the next-prayer countdown in the island</summary>
    </key>
    <key name="prayer-lead-minutes" type="i">
      <range min="1" max="120"/>
      <default>15</default>
      <summary>Minutes before a prayer to start the countdown</summary>
    </key>

    <!-- Appearance and behaviour -->
    <key name="reserve-space" type="b">
      <default>true</default>
      <summary>Keep maximised windows below the island</summary>
    </key>
    <key name="style" type="s">
      <choices>
        <choice value="solid"/>
        <choice value="blur"/>
      </choices>
      <default>'solid'</default>
      <summary>Island background</summary>
    </key>
    <key name="reduce-motion" type="b">
      <default>false</default>
      <summary>Turn off morph animations</summary>
    </key>
    <key name="toggle-shortcut" type="as">
      <default><![CDATA[['<Super>b']]]></default>
      <summary>Shortcut to expand or collapse the island</summary>
    </key>

    <!-- Testing -->
    <key name="debug-fake-prayer-minutes" type="i">
      <default>-1</default>
      <summary>Testing only: pretend the next prayer is this many minutes after enable (-1 = off)</summary>
    </key>
  </schema>
</schemalist>
```

- [ ] **Step 3: Validate the schema**

Run: `glib-compile-schemas --strict --dry-run schemas && echo SCHEMA_OK`
Expected: `SCHEMA_OK`

- [ ] **Step 4: Create `.gitignore`**

```
schemas/gschemas.compiled
.nested/
```

- [ ] **Step 5: Create `tests/harness.js`**

```js
// Minimal test harness for `gjs -m tests/run.js`. No GNOME Shell imports.

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function assertEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`);
}

export function assert(condition, message = 'assertion failed') {
    if (!condition)
        throw new Error(message);
}

export async function runAll() {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`\n${tests.length - failed}/${tests.length} passed`);
    return failed;
}
```

- [ ] **Step 6: Create `tests/run.js`** (later tasks add test imports)

```js
import System from 'system';
import {runAll} from './harness.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
```

- [ ] **Step 7: Run the empty suite**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: last line `0/0 passed`, exit code 0.

- [ ] **Step 8: Create `scripts/install.sh`**

```bash
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
```

- [ ] **Step 9: Create `scripts/nested.sh`**

```bash
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
```

- [ ] **Step 10: Create `scripts/in-nested.sh`**

```bash
#!/usr/bin/env bash
# Runs a command against the nested shell started by scripts/nested.sh,
# e.g.:  scripts/in-nested.sh notify-send "Hello" "From the island"
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ ! -f "$root/.nested/bus" ]] || ! pgrep -f '^gnome-shell --devkit' >/dev/null; then
    echo "No nested shell running; start scripts/nested.sh first." >&2
    exit 1
fi
DBUS_SESSION_BUS_ADDRESS=$(cat "$root/.nested/bus") XDG_CONFIG_HOME="$root/.nested/config" exec "$@"
```

- [ ] **Step 11: Create `scripts/nested-eval.sh`**

```bash
#!/usr/bin/env bash
# Evaluates JavaScript inside the nested shell and prints the result.
#   scripts/nested-eval.sh 'Main.layoutManager.panelBox.visible'
# Code containing "return" runs as a function body:
#   scripts/nested-eval.sh 'const i = Main.panel; return i.visible'
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
code=$1
if [[ $code == *return* ]]; then
    code="(() => { $code })()"
fi
out=$("$root/scripts/in-nested.sh" gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$code")
# gdbus prints (true, 'result') or (false, 'error')
python3 - "$out" <<'PY'
import ast, sys
out = sys.argv[1].strip()
ok = out.startswith('(true')
result = ast.literal_eval(out[out.index(',') + 1:].rstrip(')').strip())
print(result)
sys.exit(0 if ok else 1)
PY
```

- [ ] **Step 12: Create `scripts/nested-shot.sh`**

```bash
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
```

- [ ] **Step 13: Create `scripts/nested-stop.sh`**

```bash
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
```

- [ ] **Step 14: Create `tools/dynland-devtools@gawad-b.github.io/metadata.json`**

```json
{
  "uuid": "dynland-devtools@gawad-b.github.io",
  "name": "Dynland dev tools (nested shell only)",
  "description": "Puts the nested test shell in unsafe mode so scripts can use org.gnome.Shell.Eval and Screenshot. Never install in a real session.",
  "shell-version": ["50", "51"],
  "version": 1
}
```

- [ ] **Step 15: Create `tools/dynland-devtools@gawad-b.github.io/extension.js`**

```js
// Nested-shell-only helper: unsafe mode lets scripts/nested-eval.sh and
// scripts/nested-shot.sh use org.gnome.Shell.Eval and Screenshot.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DevToolsExtension extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
```

- [ ] **Step 16: Make scripts executable and syntax-check them**

Run: `chmod +x scripts/*.sh && for s in scripts/*.sh; do bash -n "$s"; done && node --check tools/dynland-devtools@gawad-b.github.io/extension.js && echo OK`
Expected: `OK`

- [ ] **Step 17: Smoke-test the nested harness** (Dynland itself isn't built yet; the nested shell just shows GNOME's normal bar)

```bash
free -h
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
scripts/nested-eval.sh 'Object.keys(Main.panel.statusArea).join(",")'
scripts/nested-shot.sh smoke
scripts/nested-stop.sh
```

Expected: the loop ends within ~40 s; the eval prints a list starting with `activities,dateMenu`; the screenshot PNG (Read it) shows a normal GNOME desktop with the stock top bar; after `nested-stop.sh`, `pgrep -f '^gnome-shell --devkit'` prints nothing.

- [ ] **Step 18: Commit**

```bash
git add metadata.json schemas .gitignore tests scripts tools
git commit -m "Scaffold Dynland: metadata, settings schema, test harness, dev scripts"
```

---

### Task 2: Indicator layout (`lib/layout.js`)

Decides which island slot each GNOME panel indicator goes to.

**Files:**
- Create: `lib/layout.js`
- Test: `tests/layout.test.js`
- Modify: `tests/run.js`

**Interfaces:**
- Produces: `splitIndicators(panelRoles: {left: string[], center: string[], right: string[]}, prefs: {showClock, showQuickSettings, showActivities, showTrayIndicators: boolean, idleIndicators: string[]}) → {left, center, right, extra: string[]}`. Roles not returned stay in GNOME's hidden panel. Used by `PanelBridge.refresh()` (Task 6).

- [ ] **Step 1: Write the failing test `tests/layout.test.js`**

```js
import {test, assertEqual} from './harness.js';
import {splitIndicators} from '../lib/layout.js';

const PANEL = {
    left: ['activities', 'apps-menu'],
    center: ['dateMenu', 'vitals'],
    right: ['clipboard', 'appindicator', 'quickSettings'],
};

const DEFAULTS = {
    showClock: true,
    showQuickSettings: true,
    showActivities: true,
    showTrayIndicators: true,
    idleIndicators: ['quickSettings'],
};

test('defaults: activities left, clock centre, quick settings right, rest expanded', () => {
    assertEqual(splitIndicators(PANEL, DEFAULTS), {
        left: ['activities'],
        center: ['dateMenu'],
        right: ['quickSettings'],
        extra: ['apps-menu', 'vitals', 'clipboard', 'appindicator'],
    });
});

test('idle indicators move to the idle row, Quick Settings stays rightmost', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, idleIndicators: ['quickSettings', 'vitals']});
    assertEqual(r.right, ['vitals', 'quickSettings']);
    assertEqual(r.extra, ['apps-menu', 'clipboard', 'appindicator']);
});

test('turned-off items stay in the hidden panel', () => {
    const r = splitIndicators(PANEL, {
        ...DEFAULTS,
        showClock: false,
        showQuickSettings: false,
        showActivities: false,
        showTrayIndicators: false,
    });
    assertEqual(r, {left: [], center: [], right: [], extra: []});
});

test('an idle indicator still shows when tray indicators are off', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, showTrayIndicators: false, idleIndicators: ['vitals', 'quickSettings']});
    assertEqual(r.right, ['vitals', 'quickSettings']);
    assertEqual(r.extra, []);
});

test('Quick Settings not in idle list goes to the expanded row', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, idleIndicators: []});
    assertEqual(r.right, []);
    assertEqual(r.extra.at(-1), 'quickSettings');
});
```

- [ ] **Step 2: Add it to `tests/run.js`**

```js
import System from 'system';
import {runAll} from './harness.js';
import './layout.test.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: FAIL — module `../lib/layout.js` not found.

- [ ] **Step 4: Create `lib/layout.js`**

```js
// Decides where each panel indicator goes in the island. Pure logic.

/**
 * Splits panel indicators between the island's idle row and its expanded row.
 * Roles left out of the result stay in the hidden GNOME panel.
 *
 * @param {{left: string[], center: string[], right: string[]}} panelRoles
 *   statusArea role names in GNOME's panel order
 * @param {object} prefs
 * @param {boolean} prefs.showClock
 * @param {boolean} prefs.showQuickSettings
 * @param {boolean} prefs.showActivities
 * @param {boolean} prefs.showTrayIndicators
 * @param {string[]} prefs.idleIndicators roles shown on the right of the idle pill
 * @returns {{left: string[], center: string[], right: string[], extra: string[]}}
 */
export function splitIndicators(panelRoles, prefs) {
    const result = {left: [], center: [], right: [], extra: []};
    const all = [...panelRoles.left, ...panelRoles.center, ...panelRoles.right];

    for (const role of all) {
        if (role === 'activities') {
            if (prefs.showActivities)
                result.left.push(role);
        } else if (role === 'dateMenu') {
            if (prefs.showClock)
                result.center.push(role);
        } else if (role === 'quickSettings') {
            if (!prefs.showQuickSettings)
                continue;
            if (prefs.idleIndicators.includes(role))
                result.right.push(role);
            else
                result.extra.push(role);
        } else if (prefs.idleIndicators.includes(role)) {
            result.right.push(role);
        } else if (prefs.showTrayIndicators) {
            result.extra.push(role);
        }
    }

    // Quick Settings is the rightmost control in the idle pill, like the top bar.
    const qs = result.right.indexOf('quickSettings');
    if (qs !== -1 && qs !== result.right.length - 1)
        result.right.push(...result.right.splice(qs, 1));

    return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: `5/5 passed`

- [ ] **Step 6: Commit**

```bash
git add lib/layout.js tests/layout.test.js tests/run.js
git commit -m "Add indicator layout split"
```

---

### Task 3: Activity manager (`lib/activityManager.js`)

Decides which live activity the island shows. Timers are injected so tests drive time by hand.

**Files:**
- Create: `lib/activityManager.js`, `tests/fakeTimers.js`
- Test: `tests/activityManager.test.js`
- Modify: `tests/run.js`

**Interfaces:**
- Produces:
  - `Priority = {NOTIFICATION: 50, OSD: 40, POWER: 30, PRAYER: 20, MEDIA: 10}`
  - `new ActivityManager({setTimeout(fn, ms) → handle, clearTimeout(handle), onChange(current), onError?(id, error)})`
  - `request(id, priority, content: {compact: () => St.Widget, expanded?: () => St.Widget, timeoutMs?: number, onEnd?: () => void})` — the same id replaces its content without calling `onEnd`
  - `release(id)` (calls `onEnd`), `hold(id, held)` (pause / restart timeout), `guard(id, fn) → fn` (exceptions go to `onError`), `clear()` (drop all, no `onEnd`), getter `current → ?{id, content}`
  - `onChange` fires only when the shown request changes.

- [ ] **Step 1: Create `tests/fakeTimers.js`**

```js
// Manual clock for ActivityManager tests.

export class FakeTimers {
    constructor() {
        this.now = 0;
        this._timers = new Map();
        this._nextId = 1;
        this.setTimeout = (fn, ms) => {
            const id = this._nextId++;
            this._timers.set(id, {fn, at: this.now + ms});
            return id;
        };
        this.clearTimeout = id => this._timers.delete(id);
    }

    tick(ms) {
        const end = this.now + ms;
        for (;;) {
            let next = null;
            for (const [id, t] of this._timers) {
                if (t.at <= end && (!next || t.at < next[1].at))
                    next = [id, t];
            }
            if (!next)
                break;
            this._timers.delete(next[0]);
            this.now = next[1].at;
            next[1].fn();
        }
        this.now = end;
    }
}
```

- [ ] **Step 2: Write the failing test `tests/activityManager.test.js`**

```js
import {test, assert, assertEqual} from './harness.js';
import {FakeTimers} from './fakeTimers.js';
import {ActivityManager, Priority} from '../lib/activityManager.js';

function setup() {
    const timers = new FakeTimers();
    const changes = [];
    const errors = [];
    const manager = new ActivityManager({
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        onChange: current => changes.push(current?.id ?? null),
        onError: (id, e) => errors.push([id, e.message]),
    });
    return {timers, changes, errors, manager};
}

const content = (extra = {}) => ({compact: () => null, ...extra});

test('higher priority wins', () => {
    const {manager} = setup();
    manager.request('media', Priority.MEDIA, content());
    manager.request('notification', Priority.NOTIFICATION, content());
    assertEqual(manager.current.id, 'notification');
});

test('equal priority: newest wins', () => {
    const {manager} = setup();
    manager.request('a', Priority.OSD, content());
    manager.request('b', Priority.OSD, content());
    assertEqual(manager.current.id, 'b');
});

test('timeout releases the request and calls onEnd', () => {
    const {manager, timers, changes} = setup();
    let ended = 0;
    manager.request('osd', Priority.OSD, content({timeoutMs: 1500, onEnd: () => ended++}));
    timers.tick(1499);
    assertEqual(manager.current.id, 'osd');
    timers.tick(1);
    assertEqual(manager.current, null);
    assertEqual(ended, 1);
    assertEqual(changes, ['osd', null]);
});

test('pre-empted request resumes when the higher one ends', () => {
    const {manager, timers, changes} = setup();
    manager.request('media', Priority.MEDIA, content());
    manager.request('notification', Priority.NOTIFICATION, content({timeoutMs: 5000}));
    timers.tick(5000);
    assertEqual(manager.current.id, 'media');
    assertEqual(changes, ['media', 'notification', 'media']);
});

test('pre-empted request that expires meanwhile does not resume', () => {
    const {manager, timers} = setup();
    manager.request('power', Priority.POWER, content({timeoutMs: 3000}));
    manager.request('notification', Priority.NOTIFICATION, content({timeoutMs: 5000}));
    timers.tick(5000);
    assertEqual(manager.current, null);
});

test('hold pauses the timeout; unhold restarts it in full', () => {
    const {manager, timers} = setup();
    manager.request('notification', Priority.NOTIFICATION, content({timeoutMs: 5000}));
    timers.tick(4000);
    manager.hold('notification', true);
    timers.tick(60000);
    assertEqual(manager.current.id, 'notification');
    manager.hold('notification', false);
    timers.tick(4999);
    assertEqual(manager.current.id, 'notification');
    timers.tick(1);
    assertEqual(manager.current, null);
});

test('re-requesting the same id replaces content without onEnd and notifies', () => {
    const {manager, changes} = setup();
    let ended = 0;
    manager.request('osd', Priority.OSD, content({onEnd: () => ended++}));
    manager.request('osd', Priority.OSD, content({onEnd: () => ended++}));
    assertEqual(ended, 0);
    assertEqual(changes, ['osd', 'osd']);
});

test('a lower-priority request does not notify while a higher one shows', () => {
    const {manager, changes} = setup();
    manager.request('notification', Priority.NOTIFICATION, content());
    manager.request('media', Priority.MEDIA, content());
    assertEqual(changes, ['notification']);
});

test('release of an unknown id is a no-op', () => {
    const {manager, changes} = setup();
    manager.release('nope');
    assertEqual(changes, []);
});

test('guard reports exceptions instead of throwing', () => {
    const {manager, errors} = setup();
    const fn = manager.guard('media', () => {
        throw new Error('boom');
    });
    fn();
    assertEqual(errors, [['media', 'boom']]);
});

test('an onEnd that throws is reported, not thrown', () => {
    const {manager, errors} = setup();
    manager.request('power', Priority.POWER, content({
        onEnd: () => {
            throw new Error('bad end');
        },
    }));
    manager.release('power');
    assertEqual(errors, [['power', 'bad end']]);
    assert(manager.current === null, 'released');
});

test('clear drops everything without onEnd', () => {
    const {manager, timers} = setup();
    let ended = 0;
    manager.request('osd', Priority.OSD, content({timeoutMs: 100, onEnd: () => ended++}));
    manager.clear();
    timers.tick(1000);
    assertEqual(manager.current, null);
    assertEqual(ended, 0);
});
```

- [ ] **Step 3: Add it to `tests/run.js`**

```js
import System from 'system';
import {runAll} from './harness.js';
import './layout.test.js';
import './activityManager.test.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: FAIL — module `../lib/activityManager.js` not found.

- [ ] **Step 5: Create `lib/activityManager.js`**

```js
// Decides which live activity the island shows. Pure logic: timers are
// injected so tests can drive time by hand.

export const Priority = {
    NOTIFICATION: 50,
    OSD: 40,
    POWER: 30,
    PRAYER: 20,
    MEDIA: 10,
};

export class ActivityManager {
    /**
     * @param {object} deps
     * @param {(fn: Function, ms: number) => any} deps.setTimeout
     * @param {(handle: any) => void} deps.clearTimeout
     * @param {(current: ?{id: string, content: object}) => void} deps.onChange
     * @param {(id: string, error: Error) => void} [deps.onError]
     */
    constructor({setTimeout, clearTimeout, onChange, onError = () => {}}) {
        this._setTimeout = setTimeout;
        this._clearTimeout = clearTimeout;
        this._onChange = onChange;
        this._onError = onError;
        this._requests = new Map();
        this._seq = 0;
        this._current = null;
    }

    /**
     * Shows (or replaces) an activity's content.
     *
     * @param {string} id
     * @param {number} priority one of Priority
     * @param {object} content
     * @param {Function} content.compact returns the compact St actor
     * @param {Function} [content.expanded] returns the expanded St actor
     * @param {number} [content.timeoutMs] auto-release after this long; 0 = never
     * @param {Function} [content.onEnd] called when released or timed out (not when replaced)
     */
    request(id, priority, content) {
        const old = this._requests.get(id);
        if (old)
            this._stopTimer(old);

        const req = {id, priority, content, seq: ++this._seq, held: false, timer: null};
        this._requests.set(id, req);
        this._startTimer(req);
        this._update();
    }

    release(id) {
        const req = this._requests.get(id);
        if (!req)
            return;

        this._stopTimer(req);
        this._requests.delete(id);
        this._update();
        this.guard(id, () => req.content.onEnd?.())();
    }

    /** Pauses (held = true) or restarts (held = false) an activity's timeout. */
    hold(id, held) {
        const req = this._requests.get(id);
        if (!req || req.held === held)
            return;

        req.held = held;
        if (held)
            this._stopTimer(req);
        else
            this._startTimer(req);
    }

    /** Wraps a callback so an exception reports the activity instead of escaping. */
    guard(id, fn) {
        return (...args) => {
            try {
                return fn(...args);
            } catch (e) {
                this._onError(id, e);
                return undefined;
            }
        };
    }

    get current() {
        return this._current ? {id: this._current.id, content: this._current.content} : null;
    }

    /** Drops every request without calling onEnd. Used on disable. */
    clear() {
        for (const req of this._requests.values())
            this._stopTimer(req);
        this._requests.clear();
        this._update();
    }

    _startTimer(req) {
        const ms = req.content.timeoutMs ?? 0;
        if (ms <= 0 || req.held)
            return;

        req.timer = this._setTimeout(() => {
            req.timer = null;
            if (this._requests.get(req.id) === req)
                this.release(req.id);
        }, ms);
    }

    _stopTimer(req) {
        if (req.timer !== null) {
            this._clearTimeout(req.timer);
            req.timer = null;
        }
    }

    _update() {
        let best = null;
        for (const req of this._requests.values()) {
            if (!best || req.priority > best.priority ||
                (req.priority === best.priority && req.seq > best.seq))
                best = req;
        }
        if (best === this._current)
            return;

        this._current = best;
        this._onChange(this.current);
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: `17/17 passed`

- [ ] **Step 7: Commit**

```bash
git add lib/activityManager.js tests/activityManager.test.js tests/run.js tests/fakeTimers.js
git commit -m "Add activity manager with priorities, pre-emption and timeouts"
```

---

### Task 4: Prayer-time maths (`lib/prayerCalc.js`)

The reference times in the test come from the adhan library bundled in the installed `prayer-times@gawad-b.github.io` extension, so the island agrees with the times the user already sees. MoonsightingCommittee isn't in the test: adhan applies seasonal twilight rules this compact algorithm only approximates.

**Files:**
- Create: `lib/prayerCalc.js`
- Test: `tests/prayerCalc.test.js`
- Modify: `tests/run.js`

**Interfaces:**
- Produces:
  - `PRAYER_NAMES = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']`
  - `computeTimes({latitude, longitude, date: {year, month /* 1-12 */, day}, method, madhab, highLatitudeRule}) → {fajr, sunrise, dhuhr, asr, maghrib, isha}` (each a `Date` rounded to the minute; string arguments use the prayer-times extension's GSettings values)
  - `nextPrayer(today, tomorrow, now) → {name, time}` (Sunrise skipped; after Isha → tomorrow's Fajr)

- [ ] **Step 1: Write the failing test `tests/prayerCalc.test.js`**

```js
import {test, assert} from './harness.js';
import {computeTimes, nextPrayer} from '../lib/prayerCalc.js';

// Reference times produced by the adhan library bundled in the
// prayer-times@gawad-b.github.io extension (local wall-clock times).
const REFERENCE = [
    {name: 'Cairo', lat: 30.0444, lon: 31.2357, method: 'Egyptian', madhab: 'Shafi', date: '2026-03-20', tz: 2, fajr: '04:32', sunrise: '05:59', dhuhr: '12:04', asr: '15:30', maghrib: '18:06', isha: '19:24'},
    {name: 'Cairo', lat: 30.0444, lon: 31.2357, method: 'Egyptian', madhab: 'Shafi', date: '2026-06-21', tz: 3, fajr: '04:08', sunrise: '05:54', dhuhr: '12:58', asr: '16:32', maghrib: '19:59', isha: '21:33'},
    {name: 'Makkah', lat: 21.4225, lon: 39.8262, method: 'UmmAlQura', madhab: 'Shafi', date: '2026-12-21', tz: 3, fajr: '05:32', sunrise: '06:54', dhuhr: '12:19', asr: '15:23', maghrib: '17:44', isha: '19:14'},
    {name: 'NewYork', lat: 40.7128, lon: -74.006, method: 'NorthAmerica', madhab: 'Hanafi', date: '2026-09-01', tz: -4, fajr: '05:04', sunrise: '06:23', dhuhr: '12:57', asr: '17:33', maghrib: '19:28', isha: '20:47'},
    {name: 'London', lat: 51.5074, lon: -0.1278, method: 'MuslimWorldLeague', madhab: 'Shafi', date: '2026-01-15', tz: 0, fajr: '05:59', sunrise: '07:59', dhuhr: '12:11', asr: '14:02', maghrib: '16:21', isha: '18:15'},
    {name: 'Tehran', lat: 35.6892, lon: 51.389, method: 'Tehran', madhab: 'Shafi', date: '2026-04-10', tz: 3.5, fajr: '04:12', sunrise: '05:39', dhuhr: '12:06', asr: '15:44', maghrib: '18:52', isha: '19:41'},
    {name: 'Karachi', lat: 24.8607, lon: 67.0011, method: 'Karachi', madhab: 'Hanafi', date: '2026-07-01', tz: 5, fajr: '04:17', sunrise: '05:46', dhuhr: '12:37', asr: '17:18', maghrib: '19:26', isha: '20:54'},
    {name: 'Istanbul', lat: 41.0082, lon: 28.9784, method: 'Turkey', madhab: 'Shafi', date: '2026-10-05', tz: 3, fajr: '05:33', sunrise: '06:58', dhuhr: '12:58', asr: '16:10', maghrib: '18:47', isha: '20:06'},
];

const TOLERANCE_MIN = 2;

function localMinutes(date, tz) {
    const t = new Date(date.getTime() + tz * 3600e3);
    return t.getUTCHours() * 60 + t.getUTCMinutes();
}

for (const ref of REFERENCE) {
    test(`prayerCalc matches adhan: ${ref.name} ${ref.date} (${ref.method})`, () => {
        const [year, month, day] = ref.date.split('-').map(Number);
        const times = computeTimes({
            latitude: ref.lat, longitude: ref.lon, date: {year, month, day},
            method: ref.method, madhab: ref.madhab, highLatitudeRule: 'None',
        });
        for (const key of ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']) {
            const [hh, mm] = ref[key].split(':').map(Number);
            const diff = Math.abs(localMinutes(times[key], ref.tz) - (hh * 60 + mm));
            assert(diff <= TOLERANCE_MIN, `${key}: expected ${ref[key]}, off by ${diff} min`);
        }
    });
}

test('nextPrayer picks the first prayer after now, skipping Sunrise', () => {
    const at = h => new Date(Date.UTC(2026, 0, 1, h));
    const today = {fajr: at(5), sunrise: at(6), dhuhr: at(12), asr: at(15), maghrib: at(18), isha: at(19)};
    const tomorrow = {...today, fajr: new Date(Date.UTC(2026, 0, 2, 5))};
    assert(nextPrayer(today, tomorrow, at(7)).name === 'Dhuhr', 'after sunrise should be Dhuhr');
    assert(nextPrayer(today, tomorrow, at(20)).time.getTime() === tomorrow.fajr.getTime(), 'after Isha should be tomorrow Fajr');
});
```

- [ ] **Step 2: Add it to `tests/run.js`**

```js
import System from 'system';
import {runAll} from './harness.js';
import './activityManager.test.js';
import './layout.test.js';
import './prayerCalc.test.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: FAIL — module `../lib/prayerCalc.js` not found.

- [ ] **Step 4: Create `lib/prayerCalc.js`**

```js
// Prayer-time maths (praytimes.org algorithm), tuned to match the adhan
// library used by the prayer-times extension. Pure: no GNOME imports.

const METHODS = {
    MuslimWorldLeague: {fajr: 18, isha: 17, adjust: {dhuhr: 1}},
    Egyptian: {fajr: 19.5, isha: 17.5, adjust: {dhuhr: 1}},
    Karachi: {fajr: 18, isha: 18, adjust: {dhuhr: 1}},
    UmmAlQura: {fajr: 18.5, ishaInterval: 90, adjust: {}},
    Dubai: {fajr: 18.2, isha: 18.2, adjust: {sunrise: -3, dhuhr: 3, asr: 3, maghrib: 3}},
    MoonsightingCommittee: {fajr: 18, isha: 18, adjust: {dhuhr: 5, maghrib: 3}},
    NorthAmerica: {fajr: 15, isha: 15, adjust: {dhuhr: 1}},
    Singapore: {fajr: 20, isha: 18, adjust: {dhuhr: 1}},
    Tehran: {fajr: 17.7, isha: 14, maghribAngle: 4.5, adjust: {}},
    Turkey: {fajr: 18, isha: 17, adjust: {sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7}},
};

export const PRAYER_NAMES = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const fix = (a, b) => {
    a -= b * Math.floor(a / b);
    return a < 0 ? a + b : a;
};

function julian(year, month, day) {
    if (month <= 2) {
        year -= 1;
        month += 12;
    }
    const A = Math.floor(year / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

function sunPosition(jd) {
    const D = jd - 2451545.0;
    const g = fix(357.529 + 0.98560028 * D, 360);
    const q = fix(280.459 + 0.98564736 * D, 360);
    const L = fix(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)), 360);
    const e = 23.439 - 0.00000036 * D;
    const ra = deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15;
    return {
        declination: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L)))),
        equation: q / 15 - fix(ra, 24),
    };
}

/**
 * Computes one day's prayer times.
 *
 * @param {object} opts
 * @param {number} opts.latitude
 * @param {number} opts.longitude
 * @param {{year: number, month: number, day: number}} opts.date local calendar date (month 1-12)
 * @param {string} opts.method a key of METHODS (prayer-times' `calculation-method` values)
 * @param {string} opts.madhab 'Shafi' or 'Hanafi'
 * @param {string} opts.highLatitudeRule 'None', 'MiddleOfTheNight', 'SeventhOfTheNight' or 'TwilightAngle'
 * @returns {{fajr: Date, sunrise: Date, dhuhr: Date, asr: Date, maghrib: Date, isha: Date}}
 */
export function computeTimes({latitude, longitude, date, method, madhab, highLatitudeRule}) {
    const m = METHODS[method] ?? METHODS.MuslimWorldLeague;
    const jd = julian(date.year, date.month, date.day) - longitude / (15 * 24);

    const midDay = t => fix(12 - sunPosition(jd + t).equation, 24);
    const angleTime = (angle, t, ccw) => {
        const decl = sunPosition(jd + t).declination;
        const cosT = (-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(latitude))) /
            (Math.cos(rad(decl)) * Math.cos(rad(latitude)));
        const T = deg(Math.acos(cosT)) / 15;
        return midDay(t) + (ccw ? -T : T);
    };
    const asrTime = (factor, t) => {
        const decl = sunPosition(jd + t).declination;
        const angle = -deg(Math.atan(1 / (factor + Math.tan(rad(Math.abs(latitude - decl))))));
        return angleTime(angle, t, false);
    };

    // Two refinement passes from rough guesses (hours, local solar time).
    let h = {fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, maghrib: 18, isha: 18};
    for (let pass = 0; pass < 2; pass++) {
        const t = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v / 24]));
        h = {
            fajr: angleTime(m.fajr, t.fajr, true),
            sunrise: angleTime(0.833, t.sunrise, true),
            dhuhr: midDay(t.dhuhr),
            asr: asrTime(madhab === 'Hanafi' ? 2 : 1, t.asr),
            sunset: angleTime(0.833, t.sunset, false),
            maghrib: m.maghribAngle ? angleTime(m.maghribAngle, t.maghrib, false) : angleTime(0.833, t.maghrib, false),
            isha: m.ishaInterval ? h.isha : angleTime(m.isha, t.isha, false),
        };
    }
    if (m.ishaInterval)
        h.isha = h.sunset + m.ishaInterval / 60;

    // High-latitude safety (adhan applies MiddleOfTheNight unless told otherwise).
    const night = 24 - (h.sunset - h.sunrise);
    const portion = angle => {
        if (highLatitudeRule === 'SeventhOfTheNight')
            return 1 / 7;
        if (highLatitudeRule === 'TwilightAngle')
            return angle / 60;
        return 1 / 2;
    };
    const safeFajr = h.sunrise - portion(m.fajr) * night;
    if (Number.isNaN(h.fajr) || h.fajr < safeFajr)
        h.fajr = safeFajr;
    if (!m.ishaInterval) {
        const safeIsha = h.sunset + portion(m.isha) * night;
        if (Number.isNaN(h.isha) || h.isha > safeIsha)
            h.isha = safeIsha;
    }

    const base = Date.UTC(date.year, date.month - 1, date.day);
    const toDate = (hours, adjustMinutes = 0) => {
        const utcHours = hours - longitude / 15;
        const ms = base + (utcHours * 60 + adjustMinutes) * 60000;
        return new Date(Math.round(ms / 60000) * 60000);
    };
    const a = m.adjust;
    return {
        fajr: toDate(h.fajr, a.fajr),
        sunrise: toDate(h.sunrise, a.sunrise),
        dhuhr: toDate(h.dhuhr, a.dhuhr),
        asr: toDate(h.asr, a.asr),
        maghrib: toDate(h.maghrib, a.maghrib),
        isha: toDate(h.isha, a.isha),
    };
}

/**
 * Returns the next prayer (Sunrise excluded) after `now`, given today's and
 * tomorrow's times.
 *
 * @returns {{name: string, time: Date}}
 */
export function nextPrayer(today, tomorrow, now) {
    for (const name of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
        const time = today[name.toLowerCase()];
        if (time > now)
            return {name, time};
    }
    return {name: 'Fajr', time: tomorrow.fajr};
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: `26/26 passed`. If a city is off by more than 2 minutes, check that method's angles and `adjust` minutes in `METHODS` before touching the algorithm.

- [ ] **Step 6: Commit**

```bash
git add lib/prayerCalc.js tests/prayerCalc.test.js tests/run.js
git commit -m "Add prayer-time calculation matching the prayer-times extension"
```

---

### Task 5: Read other extensions' settings (`lib/extensionSettings.js`)

Opens another extension's GSettings from its own `schemas/` folder; works in the shell and in prefs.

**Files:**
- Create: `lib/extensionSettings.js`
- Test: `tests/extensionSettings.test.js`
- Modify: `tests/run.js`

**Interfaces:**
- Produces: `findExtensionDir(uuid, dataDirs?) → ?Gio.File`, `loadExtensionSettings(uuid, schemaId, dataDirs?) → ?Gio.Settings` (null when the extension or schema is missing). `dataDirs` defaults to the user data dir, then system data dirs. Used by `activities/prayer.js` (Task 11) and `prefs.js` (Task 12).

- [ ] **Step 1: Write the failing test `tests/extensionSettings.test.js`**

```js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, assert, assertEqual} from './harness.js';
import {findExtensionDir, loadExtensionSettings} from '../lib/extensionSettings.js';

const UUID = 'fake@dynland.test';
const SCHEMA_ID = 'org.gnome.shell.extensions.dynland-test-fake';

function makeDataDir() {
    const dataDir = GLib.dir_make_tmp('dynland-test-XXXXXX');
    const schemas = GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', UUID, 'schemas']);
    GLib.mkdir_with_parents(schemas, 0o755);
    GLib.file_set_contents(GLib.build_filenamev([schemas, `${SCHEMA_ID}.gschema.xml`]), `<?xml version="1.0"?>
<schemalist><schema id="${SCHEMA_ID}" path="/org/gnome/shell/extensions/dynland-test-fake/">
<key name="latitude" type="d"><default>30.5</default></key>
</schema></schemalist>`);
    const proc = Gio.Subprocess.new(['glib-compile-schemas', schemas], Gio.SubprocessFlags.NONE);
    proc.wait(null);
    assert(proc.get_successful(), 'glib-compile-schemas failed');
    return dataDir;
}

test('findExtensionDir returns null when the extension is missing', () => {
    assertEqual(findExtensionDir(UUID, ['/nonexistent-dynland']), null);
});

test('loadExtensionSettings reads a schema shipped inside the extension', () => {
    const dataDir = makeDataDir();
    assert(findExtensionDir(UUID, [dataDir]) !== null, 'dir found');
    const settings = loadExtensionSettings(UUID, SCHEMA_ID, [dataDir]);
    assert(settings !== null, 'settings loaded');
    assertEqual(settings.get_double('latitude'), 30.5);
});

test('loadExtensionSettings returns null for a missing extension', () => {
    assertEqual(loadExtensionSettings(UUID, SCHEMA_ID, ['/nonexistent-dynland']), null);
});
```

- [ ] **Step 2: Add it to `tests/run.js`**

```js
import System from 'system';
import {runAll} from './harness.js';
import './activityManager.test.js';
import './layout.test.js';
import './prayerCalc.test.js';
import './extensionSettings.test.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: FAIL — module `../lib/extensionSettings.js` not found.

- [ ] **Step 4: Create `lib/extensionSettings.js`**

```js
// Finds another extension's install folder and opens its GSettings.
// Works both in the shell and in the prefs process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * @param {string} uuid
 * @param {string[]} [dataDirs] defaults to the user data dir, then system data dirs
 * @returns {?Gio.File}
 */
export function findExtensionDir(uuid, dataDirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
    for (const dataDir of dataDirs) {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', uuid]));
        if (dir.query_exists(null))
            return dir;
    }
    return null;
}

/**
 * @param {string} uuid
 * @param {string} schemaId
 * @param {string[]} [dataDirs]
 * @returns {?Gio.Settings} null when the extension or its schema is missing
 */
export function loadExtensionSettings(uuid, schemaId, dataDirs) {
    const dir = findExtensionDir(uuid, dataDirs);
    if (!dir)
        return null;

    const schemaDir = dir.get_child('schemas');
    const parent = Gio.SettingsSchemaSource.get_default();
    const source = schemaDir.query_exists(null)
        ? Gio.SettingsSchemaSource.new_from_directory(schemaDir.get_path(), parent, false)
        : parent;
    const schema = source?.lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js`
Expected: `29/29 passed`

- [ ] **Step 6: Commit**

```bash
git add lib/extensionSettings.js tests/extensionSettings.test.js tests/run.js
git commit -m "Add helper to read other extensions' settings"
```

---

### Task 6: The island replaces the top bar

No live activities yet. This task delivers the idle pill, the expanded view, real menus opening from the island, and a clean disable.

**Files:**
- Create: `island.js`, `panelBridge.js`, `extension.js`, `stylesheet.css`

**Interfaces:**
- Consumes: `splitIndicators` (Task 2); `ActivityManager` (Task 3).
- Produces:
  - `Island` (St.BoxLayout): `new Island(settings, {anyMenuOpen: () => boolean, onActivityError: (id, error) => void})`; `slot('left'|'center'|'right'|'extra') → St.BoxLayout`; `setExpanded(bool)`, `toggleExpanded()`, getter `expanded`; `setActivity(?{id, content})`; signal `activity-hover(held: boolean)`.
  - `PanelBridge`: `new PanelBridge(settings)`, `enable(island)`, `disable()`, `refresh()`, `anyMenuOpen() → boolean`.
  - `extension.js`: `const ACTIVITIES = { settingsKey: [activityId, ActivityClass] }`, filled by Tasks 7–11. Every activity class implements `enable(manager, settings)` (throws if unsupported) and `disable()`.

- [ ] **Step 1: Create `island.js`**

```js
// The island actor: a floating pill that is idle, expanded, or showing a
// live activity, and morphs its size between those states.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOVER_EXPAND_MS = 300;
const LEAVE_COLLAPSE_MS = 600;
const MORPH_MS = 350;
const TOP_MARGIN = 6;

export const Island = GObject.registerClass({
    Signals: {
        // Emitted when the pointer starts (true) or stops (false) holding a
        // live activity open, so its timeout can pause.
        'activity-hover': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Island extends St.BoxLayout {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {object} deps
     * @param {() => boolean} deps.anyMenuOpen true while a borrowed indicator's menu is open
     * @param {(id: string, error: Error) => void} deps.onActivityError
     */
    constructor(settings, {anyMenuOpen, onActivityError}) {
        super({
            name: 'dynlandIsland',
            style_class: 'dynland-island',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });

        this._settings = settings;
        this._anyMenuOpen = anyMenuOpen;
        this._onActivityError = onActivityError;
        this._expanded = false;
        this._activity = null;
        this._activityExpanded = false;
        this._hoverTimeoutId = 0;
        this._blur = null;

        this._slots = {
            left: new St.BoxLayout({style_class: 'dynland-slot'}),
            center: new St.BoxLayout({style_class: 'dynland-slot'}),
            right: new St.BoxLayout({style_class: 'dynland-slot'}),
            extra: new St.BoxLayout({style_class: 'dynland-slot dynland-extra'}),
        };

        this._dateLabel = new St.Label({
            style_class: 'dynland-date',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        // Rows are named 'panel' so GNOME's and other extensions' `#panel`
        // CSS (button padding, workspace dots, indicator styles) applies here.
        this._row1 = new St.BoxLayout({name: 'panel', style_class: 'dynland-row', x_expand: true});
        this._row1.add_child(this._slots.left);
        this._row1.add_child(new St.Widget({x_expand: true}));
        this._row1.add_child(this._slots.center);
        this._row1.add_child(this._dateLabel);
        this._row1.add_child(new St.Widget({x_expand: true}));
        this._row1.add_child(this._slots.right);

        this._row2 = new St.BoxLayout({
            name: 'panel',
            style_class: 'dynland-row dynland-row2',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._row2.add_child(this._slots.extra);

        this._activityBin = new St.Bin({
            style_class: 'dynland-activity',
            x_expand: true,
            visible: false,
        });

        this.add_child(this._row1);
        this.add_child(this._row2);
        this.add_child(this._activityBin);

        // TARGET phase: only clicks on the pill's empty space (not on an
        // indicator, whose own gesture handles it) toggle expansion.
        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('recognize', () => this.toggleExpanded());
        this.add_action_full('dynland-toggle', Clutter.EventPhase.TARGET, this._clickGesture);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._updateDate(), this);
        this._updateDate();

        this.connect('notify::hover', () => this._onHover());
        this.connect('notify::width', () => this._reposition());
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        settings.connectObject('changed::style', () => this._updateStyle(), this);
        this._updateStyle();

        this.connect('destroy', () => this._onDestroy());
    }

    /** @param {'left'|'center'|'right'|'extra'} name */
    slot(name) {
        return this._slots[name];
    }

    get expanded() {
        return this._expanded;
    }

    setExpanded(expanded) {
        if (this._expanded === expanded)
            return;
        this._expanded = expanded;
        this._render();
    }

    toggleExpanded() {
        if (this._activity)
            this._setActivityExpanded(!this._activityExpanded);
        else
            this.setExpanded(!this._expanded);
    }

    /** @param {?{id: string, content: object}} current from ActivityManager */
    setActivity(current) {
        this._activity = current;
        this._activityExpanded = !!current && this.hover && !!current.content.expanded;
        this._render();
        // A new activity that opens under the pointer is held open like a hovered one.
        if (this._activityExpanded)
            this.emit('activity-hover', true);
    }

    vfunc_scroll_event(event) {
        return Main.wm.handleWorkspaceScroll(event);
    }

    _setActivityExpanded(expanded) {
        if (!this._activity?.content.expanded)
            expanded = false;
        if (this._activityExpanded === expanded)
            return;
        this._activityExpanded = expanded;
        this.emit('activity-hover', expanded);
        this._render();
    }

    _onHover() {
        this._clearHoverTimeout();

        if (this._activity) {
            this._setActivityExpanded(this.hover);
            return;
        }

        if (this.hover && !this._expanded) {
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_EXPAND_MS, () => {
                this._hoverTimeoutId = 0;
                this.setExpanded(true);
                return GLib.SOURCE_REMOVE;
            });
        } else if (!this.hover && this._expanded) {
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_COLLAPSE_MS, () => {
                if (this._anyMenuOpen())
                    return GLib.SOURCE_CONTINUE;
                this._hoverTimeoutId = 0;
                if (!this.hover)
                    this.setExpanded(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearHoverTimeout() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    }

    _render() {
        const activity = this._activity;

        this._activityBin.child?.destroy();
        if (activity) {
            const {content} = activity;
            const factory = this._activityExpanded && content.expanded ? content.expanded : content.compact;
            try {
                this._activityBin.set_child(factory());
            } catch (e) {
                this._onActivityError(activity.id, e);
            }
        }

        this._activityBin.visible = !!activity;
        this._row1.visible = !activity;
        this._row2.visible = !activity && this._expanded;
        this._dateLabel.visible = !activity && this._expanded;

        this._setStyleClass('dynland-expanded', !activity && this._expanded);
        this._setStyleClass('dynland-activity-expanded', !!activity && this._activityExpanded);

        this._morph();
    }

    _setStyleClass(name, on) {
        if (on)
            this.add_style_class_name(name);
        else
            this.remove_style_class_name(name);
    }

    _morph() {
        this.remove_all_transitions();
        const [oldWidth, oldHeight] = [this.width, this.height];

        this.set_size(-1, -1);
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);

        if (this._settings.get_boolean('reduce-motion') || !this.mapped || oldWidth === 0) {
            this._reposition();
            return;
        }

        this.set_size(oldWidth, oldHeight);
        this.ease({
            width,
            height,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => this.set_size(-1, -1),
        });
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.set_position(
            Math.floor(monitor.x + (monitor.width - this.width) / 2),
            monitor.y + TOP_MARGIN);
    }

    _updateDate() {
        this._dateLabel.text = GLib.DateTime.new_now_local().format('%A %-d %B');
    }

    _updateStyle() {
        const blur = this._settings.get_string('style') === 'blur';
        this._setStyleClass('dynland-blur', blur);
        if (blur && !this._blur) {
            this._blur = new Shell.BlurEffect({radius: 30, brightness: 0.7, mode: Shell.BlurMode.BACKGROUND});
            this.add_effect(this._blur);
        } else if (!blur && this._blur) {
            this.remove_effect(this._blur);
            this._blur = null;
        }
    }

    _onDestroy() {
        this._clearHoverTimeout();
        this._wallClock = null;
    }
});
```

- [ ] **Step 2: Create `panelBridge.js`**

```js
// Hides GNOME's top bar and lends its indicators to the island. GNOME's
// panel stays alive, so the shell and other extensions keep adding
// indicators to Main.panel.statusArea as usual.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {splitIndicators} from './lib/layout.js';

const LAYOUT_KEYS = [
    'show-clock', 'show-quick-settings', 'show-activities',
    'show-tray-indicators', 'idle-indicators',
];

export class PanelBridge {
    /** @param {Gio.Settings} settings Dynland settings */
    constructor(settings) {
        this._settings = settings;
        this._island = null;
        this._borrowed = [];
        this._refreshId = 0;
    }

    /** @param {Island} island */
    enable(island) {
        const panel = Main.panel;
        if (!panel?._leftBox || !panel._centerBox || !panel._rightBox ||
            typeof panel._addToPanelBox !== 'function')
            throw new Error('Dynland: this GNOME Shell version has an unsupported panel layout');

        this._island = island;
        Main.layoutManager.panelBox.hide();

        // Indicators added later (another extension enabling) trigger a re-layout.
        const addToPanelBox = Object.getPrototypeOf(panel)._addToPanelBox;
        panel._addToPanelBox = (...args) => {
            addToPanelBox.apply(panel, args);
            this._scheduleRefresh();
        };

        for (const key of LAYOUT_KEYS)
            this._settings.connectObject(`changed::${key}`, () => this._scheduleRefresh(), this);

        this.refresh();
    }

    disable() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._settings.disconnectObject(this);
        delete Main.panel._addToPanelBox;
        this._restoreAll();
        Main.layoutManager.panelBox.show();
        this._island = null;
    }

    /** Puts every indicator back, then lends them out again per the current settings. */
    refresh() {
        this._restoreAll();

        const panel = Main.panel;
        const roleOf = new Map();
        for (const [role, indicator] of Object.entries(panel.statusArea))
            roleOf.set(indicator.container, role);
        const rolesIn = box => box.get_children().map(c => roleOf.get(c)).filter(Boolean);

        const split = splitIndicators({
            left: rolesIn(panel._leftBox),
            center: rolesIn(panel._centerBox),
            right: rolesIn(panel._rightBox),
        }, {
            showClock: this._settings.get_boolean('show-clock'),
            showQuickSettings: this._settings.get_boolean('show-quick-settings'),
            showActivities: this._settings.get_boolean('show-activities'),
            showTrayIndicators: this._settings.get_boolean('show-tray-indicators'),
            idleIndicators: this._settings.get_strv('idle-indicators'),
        });

        for (const [slot, roles] of Object.entries(split)) {
            for (const role of roles)
                this._borrow(role, this._island.slot(slot));
        }
    }

    /** True while the menu of any lent indicator is open. */
    anyMenuOpen() {
        return this._borrowed.some(b => b.indicator.menu?.isOpen);
    }

    _scheduleRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._refreshId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _borrow(role, target) {
        const indicator = Main.panel.statusArea[role];
        const container = indicator.container;
        const parent = container.get_parent();
        const index = parent.get_children().indexOf(container);

        parent.remove_child(container);
        target.add_child(container);
        this._borrowed.push({indicator, container, parent, index});

        indicator.connectObject('destroy', () => {
            this._borrowed = this._borrowed.filter(b => b.indicator !== indicator);
        }, this);
    }

    // Undo in reverse order so every recorded index is valid again.
    _restoreAll() {
        for (const {indicator, container, parent, index} of this._borrowed.reverse()) {
            indicator.disconnectObject(this);
            container.get_parent()?.remove_child(container);
            parent.insert_child_at_index(container, Math.min(index, parent.get_n_children()));
        }
        this._borrowed = [];
    }
}
```

- [ ] **Step 3: Create `extension.js`** (`ACTIVITIES` starts empty; Tasks 7–11 fill it)

```js
// Dynland: a dynamic island that replaces the GNOME top bar.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island} from './island.js';
import {PanelBridge} from './panelBridge.js';
import {ActivityManager} from './lib/activityManager.js';

// Settings key → [activity id, activity class]
const ACTIVITIES = {
};

// Idle pill (36px) + top margin (6px) + gap (6px).
const STRUT_HEIGHT = 48;

export default class DynlandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._activities = new Map();
        this._heldId = null;

        this._bridge = new PanelBridge(this._settings);
        this._island = new Island(this._settings, {
            anyMenuOpen: () => this._bridge.anyMenuOpen(),
            onActivityError: (id, error) => this._onActivityError(id, error),
        });
        this._manager = new ActivityManager({
            setTimeout: (fn, ms) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                fn();
                return GLib.SOURCE_REMOVE;
            }),
            clearTimeout: id => GLib.source_remove(id),
            onChange: current => this._onActivityChange(current),
            onError: (id, error) => this._onActivityError(id, error),
        });

        this._island.connect('activity-hover', (_island, held) => {
            const id = this._manager.current?.id;
            if (!id)
                return;
            this._manager.hold(id, held);
            this._heldId = held ? id : null;
        });

        Main.layoutManager.addTopChrome(this._island, {affectsStruts: false, trackFullscreen: true});
        this._bridge.enable(this._island);

        this._updateStrut();
        this._settings.connectObject('changed::reserve-space', () => this._updateStrut(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._updateStrut(), this);

        for (const key of Object.keys(ACTIVITIES)) {
            this._syncActivity(key);
            this._settings.connectObject(`changed::${key}`, () => this._syncActivity(key), this);
        }

        Main.wm.addKeybinding('toggle-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._island.toggleExpanded());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-shortcut');
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);

        for (const activity of this._activities.values())
            this._safeDisable(activity);
        this._activities.clear();
        this._manager.clear();

        // Return borrowed indicators BEFORE destroying the island, or they
        // would be destroyed with it.
        this._bridge.disable();
        this._removeStrut();
        Main.layoutManager.removeChrome(this._island);
        this._island.destroy();

        this._island = null;
        this._bridge = null;
        this._manager = null;
        this._activities = null;
        this._settings = null;
    }

    _syncActivity(key) {
        const wanted = this._settings.get_boolean(key);
        const running = this._activities.get(key);

        if (wanted && !running) {
            const [, ActivityClass] = ACTIVITIES[key];
            const activity = new ActivityClass();
            try {
                activity.enable(this._manager, this._settings);
                this._activities.set(key, activity);
            } catch (e) {
                console.warn(`Dynland: ${key} unavailable: ${e.message}`);
                this._safeDisable(activity);
            }
        } else if (!wanted && running) {
            this._activities.delete(key);
            this._safeDisable(running);
        }
    }

    _safeDisable(activity) {
        try {
            activity.disable();
        } catch (e) {
            console.error('Dynland: error while turning off an activity', e);
        }
    }

    _onActivityChange(current) {
        if (this._heldId && this._heldId !== current?.id) {
            this._manager.hold(this._heldId, false);
            this._heldId = null;
        }
        this._island.setActivity(current);
    }

    // An activity that throws is turned off for this session; its setting is untouched.
    _onActivityError(id, error) {
        console.error(`Dynland: activity "${id}" failed and was turned off`, error);
        const key = Object.keys(ACTIVITIES).find(k => ACTIVITIES[k][0] === id);
        const activity = key && this._activities.get(key);
        if (activity) {
            this._activities.delete(key);
            this._safeDisable(activity);
        }
        this._manager.release(id);
    }

    _updateStrut() {
        this._removeStrut();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._settings.get_boolean('reserve-space') || !monitor)
            return;

        // An invisible, non-reactive band: it only pushes maximised windows down.
        this._strut = new St.Widget({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: STRUT_HEIGHT,
            reactive: false,
        });
        Main.layoutManager.addTopChrome(this._strut, {affectsStruts: true, trackFullscreen: true});
    }

    _removeStrut() {
        if (!this._strut)
            return;
        Main.layoutManager.removeChrome(this._strut);
        this._strut.destroy();
        this._strut = null;
    }
}
```

- [ ] **Step 4: Create `stylesheet.css`**

```css
/* Dynland island. Rows are named #panel, so GNOME's panel-button styles
   apply to the borrowed indicators; these rules only shape the pill. */

.dynland-island {
  background-color: #000000;
  color: #ffffff;
  border-radius: 18px;
  padding: 2px 6px;
  min-width: 180px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.dynland-island.dynland-expanded,
.dynland-island.dynland-activity-expanded {
  border-radius: 24px;
  padding: 8px 12px;
}

.dynland-island.dynland-blur {
  background-color: rgba(0, 0, 0, 0.55);
}

.dynland-island .dynland-row#panel {
  background-color: transparent;
  spacing: 4px;
}

.dynland-row2 {
  padding-top: 4px;
}

.dynland-slot {
  spacing: 2px;
}

.dynland-date {
  font-weight: bold;
  padding: 0 10px;
}

.dynland-activity {
  padding: 4px 8px;
  min-height: 28px;
}

/* Shared controls */
.dynland-icon-button {
  border-radius: 999px;
  padding: 6px;
  color: #ffffff;
}
.dynland-icon-button:hover {
  background-color: rgba(255, 255, 255, 0.17);
}
.dynland-pill-button {
  border-radius: 999px;
  padding: 6px 14px;
  margin: 0 3px;
  background-color: rgba(255, 255, 255, 0.12);
  color: #ffffff;
  font-weight: bold;
}
.dynland-pill-button:hover {
  background-color: rgba(255, 255, 255, 0.22);
}
.dynland-level-track {
  height: 6px;
  border-radius: 3px;
  background-color: rgba(255, 255, 255, 0.25);
}
.dynland-level-fill {
  height: 6px;
  border-radius: 3px;
  background-color: #ffffff;
}

/* Notifications */
.dynland-notification-compact { spacing: 8px; }
.dynland-notification-title { font-weight: bold; }
.dynland-notification-card { spacing: 8px; min-width: 360px; max-width: 420px; }
.dynland-notification-header { spacing: 10px; }
.dynland-notification-body { color: rgba(255, 255, 255, 0.8); }
.dynland-notification-actions { spacing: 6px; }

/* OSD */
.dynland-osd { spacing: 10px; }
.dynland-level-label { font-weight: bold; min-width: 2em; }

/* Power */
.dynland-power { spacing: 8px; font-weight: bold; }
.dynland-power-charging { color: #57e389; }
.dynland-power-low { color: #ff7b63; }

/* Media */
.dynland-media-compact { spacing: 10px; }
.dynland-media-art { border-radius: 6px; }
.dynland-media-clock { font-weight: bold; }
.dynland-media-bars { spacing: 2px; height: 14px; }
.dynland-media-bar { width: 3px; border-radius: 2px; background-color: #57e389; }
.dynland-media-card { spacing: 10px; min-width: 380px; }
.dynland-media-top { spacing: 12px; }
.dynland-media-title { font-weight: bold; }
.dynland-media-artist { color: rgba(255, 255, 255, 0.7); }
.dynland-media-controls { spacing: 4px; }

/* Prayer */
.dynland-prayer-compact { spacing: 8px; font-weight: bold; }
.dynland-prayer-countdown { font-feature-settings: "tnum"; color: #f6d32d; }
.dynland-prayer-list { spacing: 4px; min-width: 200px; }
.dynland-prayer-row { spacing: 24px; }
.dynland-prayer-next { color: #f6d32d; font-weight: bold; }
```

- [ ] **Step 5: Syntax-check and run unit tests**

Run: `for f in island.js panelBridge.js extension.js; do node --check "$f" || exit 1; done; GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1`
Expected: nothing from `node --check`, then `29/29 passed`.

- [ ] **Step 6: Start the nested shell**

Run (stop any other build or nested shell first; start `nested.sh` in the background, it runs until stopped):

```bash
free -h
./scripts/install.sh
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
```

Expected: a nested GNOME Shell window opens and the loop ends within ~40 s. `grep -i dynland .nested/shell.log` shows no errors. Verify every check below with `scripts/nested-shot.sh <name>` (then Read the PNG it prints) for anything visual, and `scripts/nested-eval.sh '<js>'` for state (e.g. `Main.layoutManager.panelBox.visible`, `global.stage.get_children()`). Hover/clicks: drive them from Eval where possible (e.g. `Main.uiGroup.get_children().find(a => a.name === 'dynlandIsland').setExpanded(true)`, `....toggleExpanded()`, `Main.panel.statusArea.quickSettings.menu.open()`); a check that truly needs a physical pointer or key (hover timing, Super+B, volume keys, unplugging) is listed in your report under "Needs a human check" instead of being skipped silently. Stop the shell with `scripts/nested-stop.sh` when done.

- [ ] **Step 7: Verify the island in the nested window**

1. No full-width top bar; a black pill sits centred 6 px from the top: workspace dots (left), clock (centre), Quick Settings icons (right).
2. Clicking the clock opens the calendar and notification list under the pill; clicking Quick Settings opens the real Quick Settings menu; toggling Dark Style there works.
3. Hovering ~0.3 s grows the pill to two rows: row 1 adds the full date; row 2 shows the other indicators (the enabled extensions' icons, such as Vitals, clipboard, caffeine, tray). Their menus open.
4. Leaving collapses it after ~0.6 s, but not while a row-2 menu is open.
5. Super+B toggles expansion; scrolling on the pill switches workspaces; clicking an empty part of the pill toggles expansion.
6. A maximised window (`scripts/in-nested.sh gnome-text-editor &`, then maximise) starts below the pill.
7. Settings round-trip (prefix: `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland`):
   - `show-clock false` → clock disappears; `true` → returns.
   - `idle-indicators "['<role>', 'quickSettings']"` with a role from Looking Glass (Alt+F2 → `lg` → `Object.keys(Main.panel.statusArea)`) → that indicator moves into the idle pill.
   - `style blur` → translucent frosted pill; `style solid` → back.
   - `reserve-space false` → maximised windows go under the island.
8. `scripts/in-nested.sh gnome-extensions disable dynland@gawad-b.github.io` → the stock top bar is back with every indicator in its original order and working menus. Re-enable → island again. Repeat twice.

- [ ] **Step 8: Adjust styling if needed**

If the pill isn't ~36 px tall or buttons look unpadded, change only `stylesheet.css` (`.dynland-island` padding, `.dynland-row#panel`). Reload with disable/enable in the nested shell.

- [ ] **Step 9: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add island.js panelBridge.js extension.js stylesheet.css
git commit -m "Add the island: replaces the top bar and lends it the real indicators"
```

---

### Task 7: Notifications in the island

GNOME's banner is suppressed by keeping `MessageTray.bannerBlocked` true. GNOME's calendar menu also writes that flag (`panel.js` sets it while the calendar is open), so an instance accessor captures the calendar's wish instead, and the island stays quiet while the calendar is open.

**Files:**
- Create: `activities/notifications.js`
- Modify: `extension.js` (imports and `ACTIVITIES`)

**Interfaces:**
- Consumes: `ActivityManager.request/release/guard`, `Priority.NOTIFICATION` (Task 3); the island renders `compact` / `expanded` (Task 6).
- Produces: `export const ID = 'notification'`, `export class NotificationsActivity` with `enable(manager, settings)` and `disable()`.

- [ ] **Step 1: Create `activities/notifications.js`**

```js
// Shows notifications in the island instead of GNOME's banner.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'notification';
const TIMEOUT_MS = 5000;

export class NotificationsActivity {
    enable(manager) {
        const tray = Main.messageTray;
        const setBlocked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tray), 'bannerBlocked')?.set;
        if (!setBlocked || typeof tray.getSources !== 'function' || !('_bannerBlocked' in tray))
            throw new Error('unsupported MessageTray');

        this._manager = manager;
        this._tray = tray;
        this._setBlocked = setBlocked;
        this._queue = [];
        this._showing = null;
        this._sources = new Set();

        // GNOME blocks banners while the calendar is open (panel.js). Keep
        // its wish in _calendarBlocked and keep GNOME's own banner blocked.
        this._calendarBlocked = tray._bannerBlocked;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get: () => this._calendarBlocked,
            set: blocked => {
                this._calendarBlocked = blocked;
            },
        });
        setBlocked.call(tray, true);

        for (const source of tray.getSources())
            this._watchSource(source);
        tray.connectObject('source-added', (_tray, source) => this._watchSource(source), this);
    }

    disable() {
        this._tray.disconnectObject(this);
        for (const source of this._sources)
            source.disconnectObject(this);
        for (const notification of this._queue)
            notification.disconnectObject(this);
        this._showing?.disconnectObject(this);
        this._sources.clear();
        this._queue = [];
        this._showing = null;
        this._manager.release(ID);

        // Unacknowledged notifications still in GNOME's queue show as banners again.
        delete this._tray.bannerBlocked;
        this._setBlocked.call(this._tray, this._calendarBlocked);
    }

    _watchSource(source) {
        this._sources.add(source);
        source.connectObject(
            'notification-request-banner',
            this._manager.guard(ID, (_source, notification) => this._onBanner(notification)),
            'destroy', () => this._sources.delete(source),
            this);
    }

    // Same filters as MessageTray._onNotificationRequestBanner.
    _onBanner(notification) {
        if (this._calendarBlocked || notification.acknowledged || notification.urgency === Urgency.LOW)
            return;
        if (!notification.source.policy.showBanners && notification.urgency !== Urgency.CRITICAL)
            return;

        if (this._showing === notification) {
            this._show(notification);
            return;
        }
        if (!this._queue.includes(notification)) {
            this._queue.push(notification);
            notification.connectObject('destroy', () => this._onDestroyed(notification), this);
        }
        if (!this._showing)
            this._showNext();
    }

    _showNext() {
        this._showing = this._queue.shift() ?? null;
        if (this._showing)
            this._show(this._showing);
    }

    _show(notification) {
        this._manager.request(ID, Priority.NOTIFICATION, {
            compact: () => this._compact(notification),
            expanded: () => this._card(notification),
            timeoutMs: notification.urgency === Urgency.CRITICAL ? 0 : TIMEOUT_MS,
            onEnd: () => {
                if (this._showing !== notification)
                    return;
                notification.disconnectObject(this);
                notification.acknowledged = true;
                this._showing = null;
                this._showNext();
            },
        });
    }

    _onDestroyed(notification) {
        this._queue = this._queue.filter(n => n !== notification);
        if (this._showing === notification) {
            this._showing = null;
            this._manager.release(ID);
            this._showNext();
        }
    }

    _icon(notification, size) {
        return new St.Icon({
            gicon: notification.gicon ?? notification.source.icon,
            icon_size: size,
            style_class: 'dynland-notification-icon',
        });
    }

    _compact(notification) {
        const box = new St.BoxLayout({style_class: 'dynland-notification-compact'});
        box.add_child(this._icon(notification, 20));
        box.add_child(new St.Label({
            text: notification.title || notification.source.title || '',
            style_class: 'dynland-notification-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _card(notification) {
        const card = new St.BoxLayout({
            style_class: 'dynland-notification-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });

        const header = new St.BoxLayout({style_class: 'dynland-notification-header'});
        header.add_child(this._icon(notification, 32));

        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({
            text: notification.title || notification.source.title || '',
            style_class: 'dynland-notification-title',
        }));
        const body = new St.Label({
            text: (notification.body ?? '').replace(/<[^>]*>/g, ''),
            style_class: 'dynland-notification-body',
        });
        body.clutter_text.line_wrap = true;
        text.add_child(body);
        header.add_child(text);

        const close = new St.Button({
            style_class: 'dynland-icon-button',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            y_align: Clutter.ActorAlign.START,
        });
        close.connect('clicked', () => this._manager.release(ID));
        header.add_child(close);
        card.add_child(header);

        if (notification.actions.length > 0) {
            const actions = new St.BoxLayout({style_class: 'dynland-notification-actions'});
            for (const action of notification.actions) {
                const button = new St.Button({
                    label: action.label,
                    style_class: 'dynland-pill-button',
                    x_expand: true,
                });
                button.connect('clicked', this._manager.guard(ID, () => {
                    action.activate();
                    this._manager.release(ID);
                }));
                actions.add_child(button);
            }
            card.add_child(actions);
        }

        // Clicking the card itself opens the app; scrolling up dismisses it.
        const click = new Clutter.ClickGesture();
        click.connect('recognize', this._manager.guard(ID, () => {
            notification.activate();
            this._manager.release(ID);
        }));
        card.add_action_full('dynland-open', Clutter.EventPhase.TARGET, click);

        card.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            const up = direction === Clutter.ScrollDirection.UP ||
                (direction === Clutter.ScrollDirection.SMOOTH && event.get_scroll_delta()[1] < 0);
            if (up)
                this._manager.release(ID);
            return Clutter.EVENT_STOP;
        });

        return card;
    }
}
```

- [ ] **Step 2: Register the activity in `extension.js`**

Add this import after the `import {ActivityManager} ...` line (keep activity imports alphabetical: Media, Notifications, Osd, Power, Prayer):

```js
import * as Notifications from './activities/notifications.js';
```

Add this entry inside `const ACTIVITIES = { ... };` (keep the order notifications, media, osd, power, prayer):

```js
    'activity-notifications': [Notifications.ID, Notifications.NotificationsActivity],
```

- [ ] **Step 3: Syntax-check and run unit tests**

Run: `node --check activities/notifications.js && node --check extension.js && GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1`
Expected: `29/29 passed`

- [ ] **Step 4: Start the nested shell**

Run (stop any other build or nested shell first; start `nested.sh` in the background, it runs until stopped):

```bash
free -h
./scripts/install.sh
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
```

Expected: a nested GNOME Shell window opens and the loop ends within ~40 s. `grep -i dynland .nested/shell.log` shows no errors. Verify every check below with `scripts/nested-shot.sh <name>` (then Read the PNG it prints) for anything visual, and `scripts/nested-eval.sh '<js>'` for state (e.g. `Main.layoutManager.panelBox.visible`, `global.stage.get_children()`). Hover/clicks: drive them from Eval where possible (e.g. `Main.uiGroup.get_children().find(a => a.name === 'dynlandIsland').setExpanded(true)`, `....toggleExpanded()`, `Main.panel.statusArea.quickSettings.menu.open()`); a check that truly needs a physical pointer or key (hover timing, Super+B, volume keys, unplugging) is listed in your report under "Needs a human check" instead of being skipped silently. Stop the shell with `scripts/nested-stop.sh` when done.

- [ ] **Step 5: Verify in the nested window**

1. `scripts/in-nested.sh notify-send "Hello" "From the island"` → the pill morphs to the app icon + "Hello"; GNOME's banner does **not** appear; after 5 s the pill is idle again; the notification is in the calendar list.
2. Send again and hover → the card with the body; it stays while hovered and leaves 5 s after the pointer does.
3. `scripts/in-nested.sh notify-send -A yes=Accept -A no=Decline "Choose" "Pick one"` → hover shows two buttons; clicking one ends the island content.
4. `for i in 1 2 3; do scripts/in-nested.sh notify-send "N $i"; done` → shown one after another.
5. `scripts/in-nested.sh notify-send -u critical "Critical" "stays"` → stays until × on the hovered card.
6. Calendar open + `notify-send` → the island stays idle.
7. Do Not Disturb on → `notify-send` shows nothing in the island.
8. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland activity-notifications false` → GNOME's banner is back; `true` → island again.
9. Disable/enable the extension twice; no errors in `.nested/shell.log`.

- [ ] **Step 6: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add activities/notifications.js extension.js
git commit -m "Show notifications in the island"
```

---

### Task 8: Volume and brightness in the island

`show` and `showAll` are overridden on the `Main.osdWindowManager` instance (`showOne` calls `show`). Only `audio-volume-*` and `display-brightness-*` icons are taken; anything else, or any error, falls through to GNOME's popup.

**Files:**
- Create: `activities/osd.js`
- Modify: `extension.js` (imports and `ACTIVITIES`)

**Interfaces:**
- Consumes: `ActivityManager.request/release/guard`, `Priority.OSD` (Task 3); the island renders `compact` / `expanded` (Task 6).
- Produces: `export const ID = 'osd'`, `export class OsdActivity` with `enable(manager, settings)` and `disable()`.

- [ ] **Step 1: Create `activities/osd.js`**

```js
// Shows volume and brightness changes in the island instead of GNOME's
// centre-screen popup. Other OSDs (keyboard backlight, etc.) are untouched.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'osd';
const TIMEOUT_MS = 1500;
const TRACK_WIDTH = 120;
const HANDLED_ICONS = /^(audio-volume|display-brightness)/;

export class OsdActivity {
    enable(manager) {
        const osd = Main.osdWindowManager;
        const proto = Object.getPrototypeOf(osd);
        if (typeof proto?.show !== 'function' || typeof proto.showAll !== 'function')
            throw new Error('unsupported OsdWindowManager');

        this._manager = manager;
        this._osd = osd;

        // showOne() calls this.show(), so patching show and showAll covers all three.
        osd.show = (icon, label, levels) => {
            const level = levels?.[Main.layoutManager.primaryIndex] ??
                Object.values(levels ?? {}).find(Boolean);
            if (!this._handle(icon, level))
                proto.show.call(osd, icon, label, levels);
        };
        osd.showAll = (icon, label, level, maxLevel) => {
            if (!this._handle(icon, {level, maxLevel}))
                proto.showAll.call(osd, icon, label, level, maxLevel);
        };
    }

    disable() {
        delete this._osd.show;
        delete this._osd.showAll;
        this._manager.release(ID);
    }

    // Returns true when the island showed it; false falls back to GNOME's popup.
    _handle(icon, levels) {
        return this._manager.guard(ID, () => {
            const name = icon instanceof Gio.ThemedIcon ? icon.get_names()[0] : '';
            if (!HANDLED_ICONS.test(name) || levels?.level === undefined || levels.level === null)
                return false;

            const max = levels.maxLevel > 0 ? levels.maxLevel : 1;
            const ratio = Math.max(0, Math.min(1, levels.level / max));
            this._manager.request(ID, Priority.OSD, {
                compact: () => this._actor(icon, ratio),
                timeoutMs: TIMEOUT_MS,
            });
            return true;
        })() ?? false;
    }

    _actor(icon, ratio) {
        const box = new St.BoxLayout({style_class: 'dynland-osd'});
        box.add_child(new St.Icon({gicon: icon, icon_size: 18}));

        const track = new St.Widget({
            style_class: 'dynland-level-track',
            width: TRACK_WIDTH,
            y_align: Clutter.ActorAlign.CENTER,
        });
        track.add_child(new St.Widget({
            style_class: 'dynland-level-fill',
            width: Math.round(TRACK_WIDTH * ratio),
        }));
        box.add_child(track);

        box.add_child(new St.Label({
            text: `${Math.round(ratio * 100)}`,
            style_class: 'dynland-level-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }
}
```

- [ ] **Step 2: Register the activity in `extension.js`**

Add this import after the `import {ActivityManager} ...` line (keep activity imports alphabetical: Media, Notifications, Osd, Power, Prayer):

```js
import * as Osd from './activities/osd.js';
```

Add this entry inside `const ACTIVITIES = { ... };` (keep the order notifications, media, osd, power, prayer):

```js
    'activity-osd': [Osd.ID, Osd.OsdActivity],
```

- [ ] **Step 3: Syntax-check and run unit tests**

Run: `node --check activities/osd.js && node --check extension.js && GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1`
Expected: `29/29 passed`

- [ ] **Step 4: Start the nested shell**

Run (stop any other build or nested shell first; start `nested.sh` in the background, it runs until stopped):

```bash
free -h
./scripts/install.sh
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
```

Expected: a nested GNOME Shell window opens and the loop ends within ~40 s. `grep -i dynland .nested/shell.log` shows no errors. Verify every check below with `scripts/nested-shot.sh <name>` (then Read the PNG it prints) for anything visual, and `scripts/nested-eval.sh '<js>'` for state (e.g. `Main.layoutManager.panelBox.visible`, `global.stage.get_children()`). Hover/clicks: drive them from Eval where possible (e.g. `Main.uiGroup.get_children().find(a => a.name === 'dynlandIsland').setExpanded(true)`, `....toggleExpanded()`, `Main.panel.statusArea.quickSettings.menu.open()`); a check that truly needs a physical pointer or key (hover timing, Super+B, volume keys, unplugging) is listed in your report under "Needs a human check" instead of being skipped silently. Stop the shell with `scripts/nested-stop.sh` when done.

- [ ] **Step 5: Verify in the nested window**

1. With the nested window focused, change volume (keys or the Quick Settings slider) → the pill shows the speaker icon, a level bar and a number; no centre-screen popup; idle again 1.5 s after the last change.
2. Mute → the muted icon with its level.
3. Brightness keys (laptop) → brightness icon and level.
4. Other OSDs (keyboard backlight, if present) still use GNOME's popup.
5. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland activity-osd false` → GNOME's popup is back; `true` → island again.
6. Disable/enable twice; GNOME's popup works after the final disable.

- [ ] **Step 6: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add activities/osd.js extension.js
git commit -m "Show volume and brightness in the island"
```

---

### Task 9: Charging and low battery

Reads UPower's display device on the system bus, so the nested shell sees the real battery.

**Files:**
- Create: `activities/power.js`
- Modify: `extension.js` (imports and `ACTIVITIES`)

**Interfaces:**
- Consumes: `ActivityManager.request/release/guard`, `Priority.POWER` (Task 3); the island renders `compact` / `expanded` (Task 6).
- Produces: `export const ID = 'power'`, `export class PowerActivity` with `enable(manager, settings)` and `disable()`.

- [ ] **Step 1: Create `activities/power.js`**

```js
// Flashes the island when the charger is plugged in or out, and warns at
// 10% and 5% battery.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'power';
const TIMEOUT_MS = 3000;
const LOW_LEVELS = [10, 5];
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));

const isCharging = state =>
    state === UPower.DeviceState.CHARGING ||
    state === UPower.DeviceState.FULLY_CHARGED ||
    state === UPower.DeviceState.PENDING_CHARGE;

export class PowerActivity {
    enable(manager) {
        this._manager = manager;
        this._warned = new Set();
        this._wasCharging = null;
        this._proxy = new DeviceProxy(Gio.DBus.system,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            manager.guard(ID, (proxy, error) => {
                if (error) {
                    console.warn(`Dynland: UPower unavailable: ${error.message}`);
                    return;
                }
                this._wasCharging = isCharging(proxy.State);
                proxy.connectObject('g-properties-changed',
                    manager.guard(ID, () => this._onChanged()), this);
            }));
    }

    disable() {
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this._manager.release(ID);
    }

    _onChanged() {
        const proxy = this._proxy;
        if (!proxy.IsPresent)
            return;

        const charging = isCharging(proxy.State);
        const percent = Math.round(proxy.Percentage);

        if (charging !== this._wasCharging) {
            this._wasCharging = charging;
            if (charging)
                this._warned.clear();
            this._flash(charging ? 'charging' : 'unplugged', percent, proxy.IconName);
        }

        if (!charging) {
            for (const level of LOW_LEVELS) {
                if (percent <= level && !this._warned.has(level)) {
                    this._warned.add(level);
                    this._flash('low', percent, proxy.IconName);
                }
            }
        }
    }

    /** @param {'charging'|'unplugged'|'low'} kind */
    _flash(kind, percent, iconName) {
        this._manager.request(ID, Priority.POWER, {
            compact: () => {
                const box = new St.BoxLayout({style_class: `dynland-power dynland-power-${kind}`});
                box.add_child(new St.Icon({icon_name: iconName || 'battery-symbolic', icon_size: 18}));
                box.add_child(new St.Label({text: `${percent}%`, y_align: Clutter.ActorAlign.CENTER}));
                return box;
            },
            timeoutMs: TIMEOUT_MS,
        });
    }
}
```

- [ ] **Step 2: Register the activity in `extension.js`**

Add this import after the `import {ActivityManager} ...` line (keep activity imports alphabetical: Media, Notifications, Osd, Power, Prayer):

```js
import * as Power from './activities/power.js';
```

Add this entry inside `const ACTIVITIES = { ... };` (keep the order notifications, media, osd, power, prayer):

```js
    'activity-power': [Power.ID, Power.PowerActivity],
```

- [ ] **Step 3: Syntax-check and run unit tests**

Run: `node --check activities/power.js && node --check extension.js && GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1`
Expected: `29/29 passed`

- [ ] **Step 4: Start the nested shell**

Run (stop any other build or nested shell first; start `nested.sh` in the background, it runs until stopped):

```bash
free -h
./scripts/install.sh
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
```

Expected: a nested GNOME Shell window opens and the loop ends within ~40 s. `grep -i dynland .nested/shell.log` shows no errors. Verify every check below with `scripts/nested-shot.sh <name>` (then Read the PNG it prints) for anything visual, and `scripts/nested-eval.sh '<js>'` for state (e.g. `Main.layoutManager.panelBox.visible`, `global.stage.get_children()`). Hover/clicks: drive them from Eval where possible (e.g. `Main.uiGroup.get_children().find(a => a.name === 'dynlandIsland').setExpanded(true)`, `....toggleExpanded()`, `Main.panel.statusArea.quickSettings.menu.open()`); a check that truly needs a physical pointer or key (hover timing, Super+B, volume keys, unplugging) is listed in your report under "Needs a human check" instead of being skipped silently. Stop the shell with `scripts/nested-stop.sh` when done.

- [ ] **Step 5: Verify in the nested window**

1. Unplug the charger → the pill flashes the battery icon and percentage for 3 s.
2. Plug it back in → green flash.
3. Low warning can't be triggered safely; check Looking Glass (Alt+F2 → `lg`) shows no errors, and re-read `_onChanged()`: warnings at 10 % and 5 % only while discharging, reset when charging starts.
4. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland activity-power false` → unplugging shows nothing; `true` → flashes again.
5. Without a battery (`IsPresent` false) the activity stays silent.

- [ ] **Step 6: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add activities/power.js extension.js
git commit -m "Flash the island on charger and low-battery events"
```

---

### Task 10: Media playing

Reuses GNOME's `MprisSource`. The progress bar reads `Position` and `mpris:length` once a second. mpv has no MPRIS plugin on this machine, so Step 0 adds a fake player for testing.

**Files:**
- Create: `activities/media.js`, `tests/manual/fake-mpris.js`
- Modify: `extension.js` (imports and `ACTIVITIES`)

**Interfaces:**
- Consumes: `ActivityManager.request/release/guard`, `Priority.MEDIA` (Task 3); the island renders `compact` / `expanded` (Task 6).
- Produces: `export const ID = 'media'`, `export class MediaActivity` with `enable(manager, settings)` and `disable()`.

- [ ] **Step 0: Create `tests/manual/fake-mpris.js`** (a fake MPRIS player; `kill -USR1` toggles play/pause)

```js
// A fake MPRIS media player for testing the island's media activity.
// Usage: gjs -m tests/manual/fake-mpris.js   (Ctrl+C to quit)
// It starts "Playing"; send SIGUSR1 to toggle play/pause.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <method name="Raise"/><method name="Quit"/>
</interface></node>`;

const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Play"/><method name="Pause"/>
  <method name="Next"/><method name="Previous"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
</interface></node>`;

const LENGTH_US = 180 * 1e6;
const tracks = [['Island Song', 'Dynland Testers'], ['Second Track', 'Nobody']];
let track = 0;
let status = 'Playing';
let startedAt = Date.now();
let pausedPosition = 0;

const position = () => status === 'Playing'
    ? Math.min(LENGTH_US, pausedPosition + (Date.now() - startedAt) * 1000)
    : pausedPosition;

const metadata = () => ({
    'mpris:trackid': new GLib.Variant('o', `/org/dynland/track/${track}`),
    'mpris:length': new GLib.Variant('x', LENGTH_US),
    'xesam:title': new GLib.Variant('s', tracks[track][0]),
    'xesam:artist': new GLib.Variant('as', [tracks[track][1]]),
});

const player = {
    get PlaybackStatus() { return status; },
    get Metadata() { return metadata(); },
    get Position() { return position(); },
    CanPlay: true, CanPause: true, CanGoNext: true, CanGoPrevious: true,
    PlayPause() { setStatus(status === 'Playing' ? 'Paused' : 'Playing'); },
    Play() { setStatus('Playing'); },
    Pause() { setStatus('Paused'); },
    Next() { changeTrack(1); },
    Previous() { changeTrack(-1); },
};

const rootExport = Gio.DBusExportedObject.wrapJSObject(ROOT_XML,
    {Identity: 'Dynland Fake Player', DesktopEntry: '', Raise() {}, Quit() { loop.quit(); }});
const playerExport = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, player);

function setStatus(next) {
    pausedPosition = position();
    startedAt = Date.now();
    status = next;
    playerExport.emit_property_changed('PlaybackStatus', new GLib.Variant('s', status));
    print(`status: ${status}`);
}

function changeTrack(delta) {
    track = (track + delta + tracks.length) % tracks.length;
    pausedPosition = 0;
    startedAt = Date.now();
    playerExport.emit_property_changed('Metadata', new GLib.Variant('a{sv}', metadata()));
    print(`track: ${tracks[track][0]}`);
}

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.dynlandfake', Gio.BusNameOwnerFlags.NONE,
    connection => {
        rootExport.export(connection, '/org/mpris/MediaPlayer2');
        playerExport.export(connection, '/org/mpris/MediaPlayer2');
        print('fake player on the bus: Playing');
    }, null, () => {
        print('could not own the bus name');
        loop.quit();
    });
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 10 /* SIGUSR1 */, () => {
    player.PlayPause();
    return GLib.SOURCE_CONTINUE;
});
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2 /* SIGINT */, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
```

- [ ] **Step 1: Create `activities/media.js`**

```js
// Shows the playing track (any MPRIS player) in the island.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'media';
const PAUSED_LINGER_MS = 10000;
const BARS_INTERVAL_MS = 180;
const PROGRESS_INTERVAL_MS = 1000;
const PROGRESS_WIDTH = 260;

export class MediaActivity {
    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._players = new Set();
        this._playingSince = new Map();
        this._player = null;

        this._source = new MprisSource();
        this._source.connectObject(
            'player-added', (_source, player) => this._addPlayer(player),
            'player-removed', (_source, player) => this._removePlayer(player),
            this);
        for (const player of this._source.players)
            this._addPlayer(player);
    }

    disable() {
        this._source.disconnectObject(this);
        for (const player of this._players)
            player.disconnectObject(this);
        this._players.clear();
        this._source = null;
        this._player = null;
        this._manager.release(ID);
    }

    _addPlayer(player) {
        this._players.add(player);
        player.connectObject('changed', this._manager.guard(ID, () => this._update()), this);
        this._update();
    }

    _removePlayer(player) {
        player.disconnectObject(this);
        this._players.delete(player);
        this._playingSince.delete(player);
        if (this._player === player) {
            this._player = null;
            this._manager.release(ID);
        }
        this._update();
    }

    _update() {
        for (const player of this._players) {
            if (player.status === 'Playing' && !this._playingSince.has(player))
                this._playingSince.set(player, Date.now());
            else if (player.status !== 'Playing')
                this._playingSince.delete(player);
        }

        // The player that most recently started playing wins.
        let newest = null;
        for (const [player, since] of this._playingSince) {
            if (!newest || since > this._playingSince.get(newest))
                newest = player;
        }

        if (newest)
            this._player = newest;
        if (!this._player)
            return;

        const player = this._player;
        this._manager.request(ID, Priority.MEDIA, {
            compact: () => this._compact(player),
            expanded: () => this._expanded(player),
            timeoutMs: player.status === 'Playing' ? 0 : PAUSED_LINGER_MS,
            onEnd: () => {
                if (this._player === player)
                    this._player = null;
            },
        });
    }

    _art(player, size) {
        const gicon = player.trackCoverUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(player.trackCoverUrl)})
            : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        return new St.Icon({gicon, icon_size: size, style_class: 'dynland-media-art'});
    }

    _compact(player) {
        const box = new St.BoxLayout({style_class: 'dynland-media-compact'});
        box.add_child(this._art(player, 22));

        const clock = new St.Label({style_class: 'dynland-media-clock', y_align: Clutter.ActorAlign.CENTER});
        const updateClock = () => {
            const format = this._interface.get_string('clock-format') === '12h' ? '%-l:%M' : '%H:%M';
            clock.text = GLib.DateTime.new_now_local().format(format);
            return GLib.SOURCE_CONTINUE;
        };
        updateClock();
        const clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, updateClock);
        box.add_child(clock);

        const bars = new St.BoxLayout({style_class: 'dynland-media-bars', y_align: Clutter.ActorAlign.CENTER});
        for (let i = 0; i < 3; i++)
            bars.add_child(new St.Widget({style_class: 'dynland-media-bar', height: 6, y_align: Clutter.ActorAlign.END}));
        box.add_child(bars);

        let barsId = 0;
        if (player.status === 'Playing' && !this._settings.get_boolean('reduce-motion')) {
            barsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BARS_INTERVAL_MS, () => {
                for (const bar of bars.get_children())
                    bar.height = 4 + Math.round(Math.random() * 10);
                return GLib.SOURCE_CONTINUE;
            });
        }

        box.connect('destroy', () => {
            GLib.source_remove(clockId);
            if (barsId)
                GLib.source_remove(barsId);
        });
        return box;
    }

    _expanded(player) {
        const card = new St.BoxLayout({
            style_class: 'dynland-media-card',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const top = new St.BoxLayout({style_class: 'dynland-media-top'});
        top.add_child(this._art(player, 56));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({text: player.trackTitle || '', style_class: 'dynland-media-title'}));
        text.add_child(new St.Label({text: player.trackArtists.join(', '), style_class: 'dynland-media-artist'}));
        top.add_child(text);

        const controls = new St.BoxLayout({style_class: 'dynland-media-controls', y_align: Clutter.ActorAlign.CENTER});
        const addButton = (iconName, enabled, action) => {
            const button = new St.Button({
                style_class: 'dynland-icon-button',
                child: new St.Icon({icon_name: iconName, icon_size: 20}),
                reactive: enabled,
                opacity: enabled ? 255 : 100,
            });
            button.connect('clicked', this._manager.guard(ID, action));
            controls.add_child(button);
        };
        addButton('media-skip-backward-symbolic', player.canGoPrevious, () => player.previous());
        addButton(player.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
            player.canPlay, () => player.playPause());
        addButton('media-skip-forward-symbolic', player.canGoNext, () => player.next());
        top.add_child(controls);
        card.add_child(top);

        const track = new St.Widget({style_class: 'dynland-level-track dynland-media-progress', width: PROGRESS_WIDTH});
        const fill = new St.Widget({style_class: 'dynland-level-fill', width: 0});
        track.add_child(fill);
        card.add_child(track);

        // MprisPlayer exposes no position, so read it straight from the player.
        const busName = player._busName;
        let progressId = 0;
        let destroyed = false;
        if (busName) {
            const updateProgress = () => {
                Gio.DBus.session.call(busName, '/org/mpris/MediaPlayer2',
                    'org.freedesktop.DBus.Properties', 'GetAll',
                    new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']),
                    null, Gio.DBusCallFlags.NONE, -1, null,
                    (connection, result) => {
                        try {
                            const [props] = connection.call_finish(result).recursiveUnpack();
                            const length = props.Metadata?.['mpris:length'] ?? 0;
                            const ratio = length > 0 ? Math.min(1, (props.Position ?? 0) / length) : 0;
                            if (!destroyed)
                                fill.width = Math.round(PROGRESS_WIDTH * ratio);
                        } catch {
                            // Player went away or doesn't report position; keep the bar empty.
                        }
                    });
                return GLib.SOURCE_CONTINUE;
            };
            updateProgress();
            progressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_INTERVAL_MS, updateProgress);
        } else {
            track.hide();
        }

        card.connect('destroy', () => {
            destroyed = true;
            if (progressId)
                GLib.source_remove(progressId);
        });
        return card;
    }
}
```

- [ ] **Step 2: Register the activity in `extension.js`**

Add this import after the `import {ActivityManager} ...` line (keep activity imports alphabetical: Media, Notifications, Osd, Power, Prayer):

```js
import * as Media from './activities/media.js';
```

Add this entry inside `const ACTIVITIES = { ... };` (keep the order notifications, media, osd, power, prayer):

```js
    'activity-media': [Media.ID, Media.MediaActivity],
```

- [ ] **Step 3: Syntax-check and run unit tests**

Run: `node --check activities/media.js && node --check extension.js && GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1`
Expected: `29/29 passed`

- [ ] **Step 4: Start the nested shell**

Run (stop any other build or nested shell first; start `nested.sh` in the background, it runs until stopped):

```bash
free -h
./scripts/install.sh
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
```

Expected: a nested GNOME Shell window opens and the loop ends within ~40 s. `grep -i dynland .nested/shell.log` shows no errors. Verify every check below with `scripts/nested-shot.sh <name>` (then Read the PNG it prints) for anything visual, and `scripts/nested-eval.sh '<js>'` for state (e.g. `Main.layoutManager.panelBox.visible`, `global.stage.get_children()`). Hover/clicks: drive them from Eval where possible (e.g. `Main.uiGroup.get_children().find(a => a.name === 'dynlandIsland').setExpanded(true)`, `....toggleExpanded()`, `Main.panel.statusArea.quickSettings.menu.open()`); a check that truly needs a physical pointer or key (hover timing, Super+B, volume keys, unplugging) is listed in your report under "Needs a human check" instead of being skipped silently. Stop the shell with `scripts/nested-stop.sh` when done.

- [ ] **Step 5: Verify in the nested window**

1. In a second terminal: `scripts/in-nested.sh gjs -m tests/manual/fake-mpris.js` → the pill shows a music icon, the clock and three bouncing green bars.
2. Hover → card with "Island Song", "Dynland Testers", ⏮ ⏯ ⏭ and a filling progress bar. ⏭ → "Second Track"; ⏯ → the fake player prints `status: Paused`.
3. While paused the bars stop; 10 s after the pointer leaves, the pill goes idle.
4. `pkill -USR1 -f fake-mpris.js` → playing again, the island returns.
5. While playing, `scripts/in-nested.sh notify-send hi` → notification takes over, then media returns.
6. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland reduce-motion true` → bars are still; set back to `false`.
7. Ctrl+C the fake player → the island goes idle.
8. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland activity-media false` → nothing for media; `true` → back.

- [ ] **Step 6: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add activities/media.js extension.js tests/manual/fake-mpris.js
git commit -m "Show playing media in the island"
```

---

### Task 11: Prayer countdown

Reads location and calculation settings from the prayer-times extension's own schema (`loadExtensionSettings`) and computes times with `lib/prayerCalc.js`. The nested shell has its own settings, so the prayer-times extension needs a location there first.

**Files:**
- Create: `activities/prayer.js`
- Modify: `extension.js` (imports and `ACTIVITIES`)

**Interfaces:**
- Consumes: `ActivityManager.request/release/guard`, `Priority.PRAYER` (Task 3); the island renders `compact` / `expanded` (Task 6).
- Produces: `export const ID = 'prayer'`, `export class PrayerActivity` with `enable(manager, settings)` and `disable()`.

- [ ] **Step 1: Create `activities/prayer.js`**

```js
// Counts down to the next prayer, using the prayer-times extension's
// location and calculation settings.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Priority} from '../lib/activityManager.js';
import {loadExtensionSettings} from '../lib/extensionSettings.js';
import {computeTimes, nextPrayer, PRAYER_NAMES} from '../lib/prayerCalc.js';

export const ID = 'prayer';
export const PRAYER_TIMES_UUID = 'prayer-times@gawad-b.github.io';
export const PRAYER_TIMES_SCHEMA = 'org.gnome.shell.extensions.prayer-times';
const IDLE_CHECK_MS = 30000;
const COUNTDOWN_TICK_MS = 1000;

const pad = n => String(n).padStart(2, '0');

export class PrayerActivity {
    enable(manager, settings) {
        this._prayer = loadExtensionSettings(PRAYER_TIMES_UUID, PRAYER_TIMES_SCHEMA);
        if (!this._prayer)
            throw new Error('the Prayer Times extension is not installed');

        this._manager = manager;
        this._settings = settings;
        this._timeoutId = 0;
        const fake = settings.get_int('debug-fake-prayer-minutes');
        this._fakeAt = fake >= 0 ? new Date(Date.now() + fake * 60000) : null;
        this._tick();
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._manager?.release(ID);
        this._prayer = null;
    }

    _times(dateTime) {
        return computeTimes({
            latitude: this._prayer.get_double('latitude'),
            longitude: this._prayer.get_double('longitude'),
            date: {year: dateTime.get_year(), month: dateTime.get_month(), day: dateTime.get_day_of_month()},
            method: this._prayer.get_string('calculation-method'),
            madhab: this._prayer.get_string('madhab'),
            highLatitudeRule: this._prayer.get_string('high-latitude-rule'),
        });
    }

    _tick() {
        this._timeoutId = 0;
        const hasLocation = this._prayer.get_double('latitude') !== 0 || this._prayer.get_double('longitude') !== 0;
        let delay = IDLE_CHECK_MS;

        if (hasLocation) {
            const nowDateTime = GLib.DateTime.new_now_local();
            const today = this._times(nowDateTime);
            const tomorrow = this._times(nowDateTime.add_days(1));
            const now = new Date();
            const next = this._fakeAt && this._fakeAt > now
                ? {name: 'Test', time: this._fakeAt}
                : nextPrayer(today, tomorrow, now);

            const remaining = next.time - now;
            const lead = this._settings.get_int('prayer-lead-minutes') * 60000;
            if (remaining > 0 && remaining <= lead) {
                this._manager.request(ID, Priority.PRAYER, {
                    compact: () => this._compact(next.name, remaining),
                    expanded: () => this._list(today, next),
                    timeoutMs: 0,
                });
                delay = COUNTDOWN_TICK_MS;
            } else {
                this._manager.release(ID);
                if (remaining > lead)
                    delay = Math.max(COUNTDOWN_TICK_MS, Math.min(IDLE_CHECK_MS, remaining - lead));
            }
        } else {
            this._manager.release(ID);
        }

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay,
            this._manager.guard(ID, () => {
                this._tick();
                return GLib.SOURCE_REMOVE;
            }));
    }

    _compact(name, remaining) {
        const totalSeconds = Math.ceil(remaining / 1000);
        const box = new St.BoxLayout({style_class: 'dynland-prayer-compact'});
        box.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 16}));
        box.add_child(new St.Label({text: name, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({
            text: `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`,
            style_class: 'dynland-prayer-countdown',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _list(today, next) {
        const list = new St.BoxLayout({style_class: 'dynland-prayer-list', orientation: Clutter.Orientation.VERTICAL});
        for (const name of PRAYER_NAMES) {
            const time = today[name.toLowerCase()];
            const row = new St.BoxLayout({style_class: 'dynland-prayer-row'});
            if (name === next.name)
                row.add_style_class_name('dynland-prayer-next');
            row.add_child(new St.Label({text: name, x_expand: true}));
            row.add_child(new St.Label({
                text: GLib.DateTime.new_from_unix_local(Math.floor(time / 1000)).format('%H:%M'),
            }));
            list.add_child(row);
        }
        return list;
    }
}
```

- [ ] **Step 2: Register the activity in `extension.js`**

Add this import after the `import {ActivityManager} ...` line (keep activity imports alphabetical: Media, Notifications, Osd, Power, Prayer):

```js
import * as Prayer from './activities/prayer.js';
```

Add this entry inside `const ACTIVITIES = { ... };` (keep the order notifications, media, osd, power, prayer):

```js
    'activity-prayer': [Prayer.ID, Prayer.PrayerActivity],
```

- [ ] **Step 3: Syntax-check and run unit tests**

Run: `node --check activities/prayer.js && node --check extension.js && GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1`
Expected: `29/29 passed`

- [ ] **Step 4: Start the nested shell**

Run (stop any other build or nested shell first; start `nested.sh` in the background, it runs until stopped):

```bash
free -h
./scripts/install.sh
./scripts/nested.sh &
until scripts/nested-eval.sh 'global.context.unsafe_mode' 2>/dev/null; do sleep 1; done
```

Expected: a nested GNOME Shell window opens and the loop ends within ~40 s. `grep -i dynland .nested/shell.log` shows no errors. Verify every check below with `scripts/nested-shot.sh <name>` (then Read the PNG it prints) for anything visual, and `scripts/nested-eval.sh '<js>'` for state (e.g. `Main.layoutManager.panelBox.visible`, `global.stage.get_children()`). Hover/clicks: drive them from Eval where possible (e.g. `Main.uiGroup.get_children().find(a => a.name === 'dynlandIsland').setExpanded(true)`, `....toggleExpanded()`, `Main.panel.statusArea.quickSettings.menu.open()`); a check that truly needs a physical pointer or key (hover timing, Super+B, volume keys, unplugging) is listed in your report under "Needs a human check" instead of being skipped silently. Stop the shell with `scripts/nested-stop.sh` when done.

- [ ] **Step 5: Verify in the nested window**

1. Give the nested prayer-times a location (Cairo). Prefix: `scripts/in-nested.sh gsettings --schemadir ~/.local/share/gnome-shell/extensions/prayer-times@gawad-b.github.io/schemas set org.gnome.shell.extensions.prayer-times` then run it with `location-auto false`, `latitude 30.0444`, `longitude 31.2357`.
2. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland debug-fake-prayer-minutes 2`, then disable and re-enable Dynland → the pill shows "Test" with a 02:00 countdown ticking down; at 00:00 it goes idle.
3. Hover during the countdown → today's prayer list with the next prayer highlighted; times within 2 minutes of the prayer-times extension's own menu.
4. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland debug-fake-prayer-minutes -1` (always reset it).
5. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland prayer-lead-minutes 120` → if a real prayer is within 2 hours, its countdown shows; set back to `15`.
6. `scripts/in-nested.sh gsettings --schemadir schemas set org.gnome.shell.extensions.dynland activity-prayer false` → countdown gone; `true` → back.

- [ ] **Step 6: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add activities/prayer.js extension.js
git commit -m "Add prayer countdown activity"
```

---

### Task 12: Preferences window

**Files:**
- Create: `prefs.js`

**Interfaces:**
- Consumes: `loadExtensionSettings` (Task 5); every schema key (Task 1).
- Produces: three pages (Top bar, Live activities, Advanced) and a Just Perfection conflict check on its `panel` and `top-panel-position` keys.

- [ ] **Step 1: Create `prefs.js`**

```js
// Dynland preferences: a switch for every top-bar function and live activity.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {loadExtensionSettings} from './lib/extensionSettings.js';

const PRAYER_TIMES_UUID = 'prayer-times@gawad-b.github.io';
const PRAYER_TIMES_SCHEMA = 'org.gnome.shell.extensions.prayer-times';
const JUST_PERFECTION_UUID = 'just-perfection-desktop@just-perfection';
const JUST_PERFECTION_SCHEMA = 'org.gnome.shell.extensions.just-perfection';
const STYLES = ['solid', 'blur'];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function group(title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    for (const row of rows)
        g.add(row);
    return g;
}

export default class DynlandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(this._topBarPage(settings));
        window.add(this._activitiesPage(settings));
        window.add(this._advancedPage(settings));
    }

    _topBarPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Top bar', icon_name: 'view-app-grid-symbolic'});

        page.add(group('Functions', [
            switchRow(settings, 'show-clock', 'Clock', 'Opens the calendar and notification list'),
            switchRow(settings, 'show-quick-settings', 'Quick Settings', 'Wi-Fi, volume, battery and power'),
            switchRow(settings, 'show-activities', 'Activities and workspaces', 'The workspace dots'),
            switchRow(settings, 'show-tray-indicators', 'Other indicators', 'Extension and tray icons, shown when expanded'),
        ]));

        const idle = new Adw.EntryRow({
            title: 'Idle pill indicators (comma-separated)',
            text: settings.get_strv('idle-indicators').join(', '),
            show_apply_button: true,
        });
        idle.connect('apply', () => {
            settings.set_strv('idle-indicators',
                idle.text.split(',').map(s => s.trim()).filter(Boolean));
        });
        page.add(group('Idle pill', [idle],
            'Indicators always shown in the small pill. Use GNOME panel role names, such as quickSettings.'));

        const style = new Adw.ComboRow({
            title: 'Background',
            model: Gtk.StringList.new(['Solid black', 'Frosted glass']),
            selected: Math.max(0, STYLES.indexOf(settings.get_string('style'))),
        });
        style.connect('notify::selected', () => settings.set_string('style', STYLES[style.selected]));

        page.add(group('Appearance', [
            style,
            switchRow(settings, 'reserve-space', 'Keep windows below the island', 'Maximised windows start under the island instead of behind it'),
        ]));
        return page;
    }

    _activitiesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Live activities', icon_name: 'emblem-synchronizing-symbolic'});
        const hasPrayerTimes = loadExtensionSettings(PRAYER_TIMES_UUID, PRAYER_TIMES_SCHEMA) !== null;

        const prayer = switchRow(settings, 'activity-prayer', 'Prayer countdown',
            hasPrayerTimes ? 'Uses the Prayer Times extension\'s location and method' : 'Needs the Prayer Times extension');
        prayer.sensitive = hasPrayerTimes;

        const lead = Adw.SpinRow.new_with_range(1, 120, 1);
        lead.title = 'Countdown starts (minutes before)';
        settings.bind('prayer-lead-minutes', lead, 'value', Gio.SettingsBindFlags.DEFAULT);
        lead.sensitive = hasPrayerTimes;

        page.add(group('Events that take over the island', [
            switchRow(settings, 'activity-notifications', 'Notifications', 'Replaces GNOME\'s notification banner'),
            switchRow(settings, 'activity-media', 'Media playing', 'Spotify, browsers, mpv and other MPRIS players'),
            switchRow(settings, 'activity-osd', 'Volume and brightness', 'Replaces GNOME\'s centre-screen popup'),
            switchRow(settings, 'activity-power', 'Charging and low battery'),
            prayer,
            lead,
        ]));
        return page;
    }

    _advancedPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Advanced', icon_name: 'preferences-other-symbolic'});

        const shortcut = new Adw.EntryRow({
            title: 'Expand / collapse shortcut',
            text: settings.get_strv('toggle-shortcut')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const [ok] = Gtk.accelerator_parse(shortcut.text);
            if (ok)
                settings.set_strv('toggle-shortcut', [shortcut.text]);
            else
                shortcut.add_css_class('error');
        });
        shortcut.connect('changed', () => shortcut.remove_css_class('error'));

        page.add(group('Behaviour', [
            shortcut,
            switchRow(settings, 'reduce-motion', 'Reduce motion', 'Turn off the morph animations'),
        ]));
        page.add(this._compatibilityGroup());
        return page;
    }

    _compatibilityGroup() {
        const rows = [];
        const jp = loadExtensionSettings(JUST_PERFECTION_UUID, JUST_PERFECTION_SCHEMA);
        if (jp && (!jp.get_boolean('panel') || jp.get_int('top-panel-position') !== 0)) {
            rows.push(new Adw.ActionRow({
                title: 'Just Perfection is hiding or moving the top bar',
                subtitle: 'Turn on its Panel visibility and set Panel Position to Top, so the island can manage the bar.',
                icon_name: 'dialog-warning-symbolic',
            }));
        }
        if (rows.length === 0)
            rows.push(new Adw.ActionRow({title: 'No conflicts found', icon_name: 'emblem-ok-symbolic'}));
        return group('Compatibility', rows);
    }
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check prefs.js && echo ok`
Expected: `ok`

- [ ] **Step 3: Check the window against the nested shell's settings**

`free -h`, start `./scripts/nested.sh`, then `scripts/in-nested.sh gnome-extensions prefs dynland@gawad-b.github.io`.

1. Every switch changes the nested island live (clock, Quick Settings, activities, other indicators, each live activity).
2. Idle pill entry: `quickSettings, <real role>` + apply → that indicator moves into the idle pill.
3. Background combo switches solid / frosted.
4. Prayer rows are sensitive (prayer-times is installed); the lead-time spin changes `prayer-lead-minutes`.
5. Shortcut `<Super>n` + apply → Super+N toggles the island; `nonsense` + apply → the row turns red and the setting is unchanged. Reset to `<Super>b`.
6. Compatibility shows "No conflicts found". Then `scripts/in-nested.sh gsettings --schemadir ~/.local/share/gnome-shell/extensions/just-perfection-desktop@just-perfection/schemas set org.gnome.shell.extensions.just-perfection panel false`, reopen prefs → the warning row appears. Reset it to `true`.

- [ ] **Step 4: Stop the nested shell (`scripts/nested-stop.sh`), then commit**

```bash
git add prefs.js
git commit -m "Add preferences window"
```

---

### Task 13: Full verification and real-session enable

**Files:**
- Create: `README.md`

- [ ] **Step 1: Unit tests, syntax, schema**

Run: `GSETTINGS_BACKEND=memory gjs -m tests/run.js | tail -1 && for f in *.js lib/*.js activities/*.js tests/manual/*.js; do node --check "$f" || exit 1; done && glib-compile-schemas --strict --dry-run schemas && echo ALL_OK`
Expected: `29/29 passed`, then `ALL_OK`.

- [ ] **Step 2: Combined run in the nested shell** (`free -h` first)

With all activities on: start the fake player; send a notification during playback; change volume while the notification shows; set `debug-fake-prayer-minutes 1` and re-enable. Expected: notification > volume > prayer > media, each returning to the next one down when it ends (reset `debug-fake-prayer-minutes -1` afterwards). Then disable and re-enable Dynland 3 times: `grep -iE "dynland|error" .nested/shell.log` shows nothing new, and the stock top bar is intact after the last disable.

- [ ] **Step 3: Create `README.md`**

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Add README"
```

- [ ] **Step 5: Ask the user before enabling in the real session**

This changes their desktop; do it only after they say yes:

```bash
./scripts/install.sh
gnome-extensions enable dynland@gawad-b.github.io
```

On Wayland a newly installed extension loads after logging out and back in. Then confirm the island replaced the bar and `journalctl --user -b -g -i dynland` shows no errors. To back out at any time: `gnome-extensions disable dynland@gawad-b.github.io`.

- [ ] **Step 6: Clean up**

Stop any nested shell with `scripts/nested-stop.sh`, then delete the `.nested/` folder (it holds only the nested shell's throwaway settings and log).
