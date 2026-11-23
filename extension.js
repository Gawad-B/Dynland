// Dynland: a dynamic island that replaces the GNOME top bar.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppMenuButton} from './appMenu.js';
import {AutoHide} from './autoHide.js';
import {MenuBar} from './bar.js';
import {BarMotion} from './barMotion.js';
import {Bubble} from './bubble.js';
import {Corner, Island} from './island.js';
import {PanelBridge} from './panelBridge.js';
import {ActivityManager} from './lib/activityManager.js';
import * as Media from './activities/media.js';
import * as Notifications from './activities/notifications.js';
import * as Osd from './activities/osd.js';
import * as Power from './activities/power.js';
import * as Prayer from './activities/prayer.js';

// Settings key → [activity id, activity class]
const ACTIVITIES = {
    'activity-notifications': [Notifications.ID, Notifications.NotificationsActivity],
    'activity-media': [Media.ID, Media.MediaActivity],
    'activity-osd': [Osd.ID, Osd.OsdActivity],
    'activity-power': [Power.ID, Power.PowerActivity],
    'activity-prayer': [Prayer.ID, Prayer.PrayerActivity],
};

// Mutter keybinding names are global, so keep ours distinctive.
const KEYBINDING = 'dynland-toggle';

// At most this many activities show at once, each in its own bubble. In bar
// layout the first is the notch's and the second a dropdown under the bar.
const MAX_BUBBLES = 2;
const BAR_PLACEMENTS = ['notch', 'dropdown'];

// Idle pill (36px) + top margin (6px) + gap (6px), in logical pixels.
const STRUT_HEIGHT = 48;

export default class DynlandExtension extends Extension {
    enable() {
        try {
            this._enable();
        } catch (e) {
            // GNOME never calls disable() after a failed enable().
            this.disable();
            throw e;
        }
    }

    _enable() {
        this._settings = this.getSettings();
        this._activities = new Map();

        this._arrangement = this._currentArrangement();
        this._barLayout = this._arrangement !== 'island';
        this._bridge = new PanelBridge(this._settings);
        if (this._barLayout) {
            // Nothing moves between the bar's sides while an indicator menu is open.
            this._bar = new MenuBar(this._settings, {
                anyMenuOpen: () => this._bridge?.anyMenuOpen() ?? false,
            });
            this._motion = new BarMotion(this._settings, this._bar);
            this._appMenu = new AppMenuButton();
            this._bar.slot('barStart').insert_child_at_index(this._appMenu.container, 0);
        }
        this._island = new Island(this._settings, {
            anyMenuOpen: () => this._bridge.anyMenuOpen(),
        });
        this._bubbles = [];
        for (let i = 0; i < MAX_BUBBLES; i++) {
            // Beside the island each bubble follows the one before it; in bar
            // layout they sit over and under the notch, chained to nothing.
            this._bubbles.push(new Bubble(this._settings, this._island,
                this._barLayout ? null : this._bubbles.at(-1) ?? null, {
                    onActivityError: (id, error) => this._onActivityError(id, error),
                    placement: this._barLayout ? BAR_PLACEMENTS[i] : 'beside',
                }));
        }
        this._corner = new Corner(this._settings);
        this._manager = new ActivityManager({
            setTimeout: (fn, ms) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                fn();
                return GLib.SOURCE_REMOVE;
            }),
            clearTimeout: id => GLib.source_remove(id),
            onChange: () => {},
            onActiveChange: active => this._onActiveChange(active),
            onError: (id, error) => this._onActivityError(id, error),
        });

        for (const bubble of this._bubbles)
            bubble.connect('activity-hover', (_bubble, id, held) => this._manager.hold(id, held));

        // On the stage before indicators move in, so they never lay out off-stage.
        // The bubbles go on top: an opened card can reach over the corner pill.
        // The corner hides itself, so it follows fullscreen on its own (GNOME's
        // tracking would show it again). The island and bubbles slide off the
        // top for a fullscreen window (AutoHide); GNOME's tracking would hide
        // the island in one frame before the slide.
        // The bar goes first so the island and bubbles are stacked above it.
        // It sits in a clip (BarMotion) and moves for fullscreen and workspace
        // switches by itself, so GNOME must neither hide it nor count it as the
        // strut (struts follow an actor's transformed geometry): an invisible
        // band of its size, which never moves, is the strut in bar layout.
        // The clip takes no input: GNOME 51 has no input region built from
        // chrome (addChrome only tracks struts and fullscreen), and a
        // non-reactive actor is never picked, so the pointer reaches the
        // windows under it; only the reactive bar inside takes input, and
        // nothing while it is hidden off screen (BarMotion hides it).
        if (this._motion) {
            Main.layoutManager.addChrome(this._motion.strut, {affectsStruts: true, trackFullscreen: true});
            Main.layoutManager.addChrome(this._motion.clip, {affectsStruts: false, trackFullscreen: false});
        }
        Main.layoutManager.addChrome(this._island, {affectsStruts: false, trackFullscreen: false});
        for (const actor of [this._corner, ...this._bubbles])
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: false});
        // The bar's sides keep clear of the island (closed notch or opened)
        // and of the notch bubble, at their current widths.
        this._bar?.watchCentre([this._island, this._bubbles[0]]);
        this._bridge.enable(name => {
            if (name === 'corner')
                return this._corner.slot();
            if (['barStart', 'barStatus', 'barClock'].includes(name))
                return this._bar?.slot(name) ?? null;
            return this._island.slot(name);
        });
        this._autoHide = new AutoHide(this._settings, this._island, this._bubbles,
            () => this._bridge.anyMenuOpen());
        this._autoHide.enable();
        this._motion?.enable();

        this._updateStrut();
        this._syncBare();
        if (this._settings.get_boolean('debug-workspace-log'))
            this._logWorkspaceSwitches();
        this._settings.connectObject(
            'changed::reserve-space', () => {
                this._updateStrut();
                this._syncBare();
            },
            'changed::auto-hide', () => this._syncBare(), this);
        // Each of these can change the whole arrangement: rebuild it if it did.
        this._settings.connectObject(
            'changed::layout', () => this._queueRebuild(),
            'changed::bar-notch-pages', () => this._queueRebuild(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._updateStrut(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._updateStrut(), this);

        for (const key of Object.keys(ACTIVITIES)) {
            this._syncActivity(key);
            this._settings.connectObject(`changed::${key}`, () => this._syncActivity(key), this);
        }

        const action = Main.wm.addKeybinding(KEYBINDING, this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._island.toggleExpanded());
        // Keybinding names are global: on a clash NONE comes back and the
        // other owner's binding must not be removed by us.
        this._keybound = action !== Meta.KeyBindingAction.NONE;
        if (!this._keybound)
            console.warn(`Dynland: could not register the "${KEYBINDING}" shortcut`);
    }

    // Debugging aid: logs each workspace switch with the JS call stack that
    // caused it (empty when Mutter itself did, e.g. a window activating).
    _logWorkspaceSwitches() {
        const describe = w => w ? `${w.get_wm_class()} "${w.get_title()}" on ws ${w.get_workspace()?.index()}` : 'none';
        global.workspace_manager.connectObject('active-workspace-changed', manager => {
            const stack = new Error().stack.split('\n').slice(1, 12).join(' <- ');
            const anim = Main.wm._workspaceAnimation;
            console.log(`Dynland debug: animation gesture ${anim?.gestureActive} tracker ${anim?._swipeTracker?._state}`);
            console.log(`Dynland debug: switched to ws ${manager.get_active_workspace_index()}; ` +
                `focus ${describe(global.display.focus_window)}; stack: ${stack || '(none)'}`);
        }, this);
        // Raw touchpad gestures, to tell a real reverse swipe from one GNOME synthesises.
        const names = {
            [Clutter.EventType.TOUCHPAD_SWIPE]: 'swipe',
            [Clutter.EventType.TOUCHPAD_HOLD]: 'hold',
            [Clutter.EventType.TOUCHPAD_PINCH]: 'pinch',
        };
        const phases = ['begin', 'update', 'end', 'cancel'];
        let sum = [0, 0];
        global.stage.connectObject('captured-event', (_stage, event) => {
            const name = names[event.type()];
            if (!name)
                return Clutter.EVENT_PROPAGATE;
            const phase = phases[event.get_gesture_phase()] ?? event.get_gesture_phase();
            const [dx, dy] = event.get_gesture_motion_delta?.() ?? [0, 0];
            if (phase === 'update') {
                sum = [sum[0] + dx, sum[1] + dy];
                return Clutter.EVENT_PROPAGATE;
            }
            const tracker = Main.wm._workspaceAnimation?._swipeTracker;
            console.log(`Dynland debug: touchpad ${name} ${phase}, ${event.get_touchpad_gesture_finger_count()} fingers, ` +
                `moved ${sum.map(v => v.toFixed(0)).join(',')}; tracker state ${tracker?._state} enabled ${tracker?.enabled}`);
            if (phase !== 'begin')
                sum = [0, 0];
            return Clutter.EVENT_PROPAGATE;
        }, this);
        // Dash to Dock hiding and showing, to line up with the island's own log lines.
        const dock = Main.uiGroup.get_children().find(a => a.name === 'dashtodockContainer');
        this._debugDock = dock ?? null;
        dock?.connectObject(
            'showing', () => console.log('Dynland debug: Dash to Dock shows'),
            'hiding', () => console.log('Dynland debug: Dash to Dock hides'), this);
        global.display.connectObject(
            'window-demands-attention', (_d, w) => console.log(`Dynland debug: demands attention: ${describe(w)}`),
            'window-marked-urgent', (_d, w) => console.log(`Dynland debug: urgent: ${describe(w)}`),
            'notify::focus-window', () => console.log(`Dynland debug: focus -> ${describe(global.display.focus_window)}`),
            this);
    }

    // Tolerates any partially initialised state (also called after a failed enable()).
    disable() {
        if (this._keybound) {
            Main.wm.removeKeybinding(KEYBINDING);
            this._keybound = false;
        }
        this._settings?.disconnectObject(this);
        // Torn down from here on: activities ending, indicators leaving
        // their slots and the settings below no longer render or measure
        // them (they leave the stage before they are destroyed).
        for (const actor of [this._island, ...this._bubbles ?? []].filter(Boolean))
            actor.retire();
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.stage.disconnectObject(this);
        this._debugDock?.disconnectObject(this);
        this._debugDock = null;
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);

        for (const activity of this._activities?.values() ?? [])
            this._safeDisable(activity);
        this._activities?.clear();
        this._autoHide?.disable();
        this._autoHide = null;
        this._motion?.disable();
        this._manager?.clear();

        // Off the stage first: a relayout queued while indicators leave would
        // otherwise run on actors that are already gone. Chrome sits in
        // uiGroup, which has no layout of its own, so the stage keeps a list
        // of chrome actors waiting for allocation, and removing one evidently
        // does not take it off that list (every rebuild logged this): the next stage relayout (the first frame, or
        // enable() measuring the new island) would allocate the removed,
        // destroyed actor ("Spurious clutter_actor_allocate", St's "not in the
        // stage"). So run the waiting layout now, while they are all still on
        // the stage (reading an allocation that is due lays the stage out).
        // The bar is destroyed with its clip.
        const actors = [...this._bubbles ?? [], this._corner, this._island,
            ...this._motion ? [this._motion.clip, this._motion.strut] : [this._bar]].filter(Boolean);
        for (const actor of actors) {
            if (actor.get_stage())
                actor.get_allocation_box();
        }
        for (const actor of actors) {
            if (actor.get_parent())
                Main.layoutManager.removeChrome(actor);
        }
        // Return borrowed indicators BEFORE destroying the island and corner,
        // or they would be destroyed with them. The island is retired, so
        // its slots emptying does not re-render it.
        try {
            this._bridge?.disable();
        } catch (e) {
            console.error('Dynland: error while returning the top bar', e);
        }
        this._removeStrut();
        this._appMenu?.destroy();
        for (const actor of actors)
            actor.destroy();

        this._appMenu = null;
        this._bar = null;
        this._motion = null;
        this._barLayout = false;
        this._arrangement = null;
        this._island = null;
        this._bubbles = null;
        this._corner = null;
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

    // An activity keeps its bubble while it lasts; a new one takes a free
    // bubble. With two showing, the island shrinks to the clock to make room.
    _onActiveChange(active) {
        if (this._barLayout) {
            this._placeInBar(active);
            return;
        }
        const shown = active.slice(0, MAX_BUBBLES);
        const free = [];
        for (const bubble of this._bubbles) {
            const activity = shown.find(a => a.id === bubble.activity?.id);
            if (!activity)
                free.push(bubble);
            else if (activity.content !== bubble.activity.content)
                bubble.setActivity(activity);
        }
        for (const activity of shown) {
            if (!this._bubbles.some(b => b.activity?.id === activity.id)) {
                free.shift().setActivity(activity);
                // A new event shows an auto-hidden island for a moment.
                this._autoHide?.showForActivity();
            }
        }
        for (const bubble of free)
            bubble.setActivity(null);
        this._island.setCompact(shown.length > 1);
    }

    // Bar layout: the notch holds one activity, a dropdown under the bar a
    // second. An activity keeps its place while it lasts: the one in the notch
    // stays when another arrives, and a dropdown stays a dropdown when the
    // notch's activity ends (nothing is moved between the two mid-life). A
    // free notch takes the next activity to appear, and when several wait it
    // takes the least important one, the one `active` lists last (lowest
    // priority: media, then the prayer countdown, then power, OSD,
    // notification; the oldest among equals): the long-lived activity lives
    // in the notch and the transient one drops down. The dropdown takes the
    // most important of the rest. Anything beyond two waits for a free place.
    _placeInBar(active) {
        const [notch, dropdown] = this._bubbles;
        for (const bubble of this._bubbles) {
            const activity = active.find(a => a.id === bubble.activity?.id);
            if (!activity)
                bubble.setActivity(null);
            else if (activity.content !== bubble.activity.content)
                bubble.setActivity(activity);
        }
        const waiting = active.filter(a => !this._bubbles.some(b => b.activity?.id === a.id));
        let arrived = false;
        if (!notch.activity && waiting.length) {
            notch.setActivity(waiting.pop());
            arrived = true;
        }
        if (!dropdown.activity && waiting.length) {
            dropdown.setActivity(waiting.shift());
            arrived = true;
        }
        if (arrived)
            this._autoHide?.showForActivity();
        // The notch opens onto the pages only while it holds no activity.
        this._syncBare();
    }

    // An activity that throws is turned off for this session; its setting is untouched.
    _onActivityError(id, error) {
        if (!this._activities)
            return;
        console.error(`Dynland: activity "${id}" failed and was turned off`, error);
        const key = Object.keys(ACTIVITIES).find(k => ACTIVITIES[k][0] === id);
        const activity = key && this._activities.get(key);
        if (activity) {
            this._activities.delete(key);
            this._safeDisable(activity);
        }
        this._manager.release(id);
    }

    // What `layout` and `bar-notch-pages` together build: 'island' (the
    // pages setting changes nothing there), 'bar' or 'bar+pages'.
    _currentArrangement() {
        if (this._settings.get_string('layout') !== 'bar')
            return 'island';
        return this._settings.get_boolean('bar-notch-pages') ? 'bar+pages' : 'bar';
    }

    // Rebuilds everything from an idle callback, never from the settings
    // signal itself: disable() disconnects the handler that is running.
    // Only when the arrangement really changed: a key set to what it
    // already means (or changed and changed back) rebuilds nothing.
    _queueRebuild() {
        if (this._rebuildId || this._currentArrangement() === this._arrangement)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = 0;
            // GNOME may have disabled the extension meanwhile.
            if (!this._settings || this._currentArrangement() === this._arrangement)
                return GLib.SOURCE_REMOVE;
            this.disable();
            try {
                this.enable();
            } catch (e) {
                console.error('Dynland: could not rebuild after a layout change', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Windows reach under the island and it does not hide: closed, it is an
    // empty pill that opens on hover. In bar layout it is the bar's notch.
    _syncBare() {
        if (this._barLayout) {
            this._island.setBare(false);
            this._island.setNotch(true);
            // Opens only with pages, and only onto an indicator (Island._canExpand),
            // and not while an activity sits in the notch (it shows its card instead).
            this._island.setExpandable(this._arrangement === 'bar+pages' && !this._bubbles?.[0]?.activity);
            return;
        }
        this._island.setBare(!this._settings.get_boolean('reserve-space') &&
            !this._settings.get_boolean('auto-hide'));
    }

    _updateStrut() {
        this._removeStrut();
        const monitor = Main.layoutManager.primaryMonitor;
        // The bar has its own strut actor (BarMotion) in bar layout.
        if (this._barLayout || !this._settings.get_boolean('reserve-space') || !monitor)
            return;

        // An invisible, non-reactive band: it only pushes maximised windows down.
        this._strut = new St.Widget({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: STRUT_HEIGHT * St.ThemeContext.get_for_stage(global.stage).scale_factor,
            reactive: false,
        });
        Main.layoutManager.addChrome(this._strut, {affectsStruts: true, trackFullscreen: true});
    }

    _removeStrut() {
        if (!this._strut)
            return;
        Main.layoutManager.removeChrome(this._strut);
        this._strut.destroy();
        this._strut = null;
    }
}
