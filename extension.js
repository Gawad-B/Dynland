// Dynland: a dynamic island that replaces the GNOME top bar.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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

// At most this many activities show at once, each in its own bubble.
const MAX_BUBBLES = 2;

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

        this._bridge = new PanelBridge(this._settings);
        this._island = new Island(this._settings, {
            anyMenuOpen: () => this._bridge.anyMenuOpen(),
        });
        this._bubbles = [];
        for (let i = 0; i < MAX_BUBBLES; i++) {
            this._bubbles.push(new Bubble(this._settings, this._island, this._bubbles.at(-1) ?? null, {
                onActivityError: (id, error) => this._onActivityError(id, error),
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
        // The corner and bubbles hide themselves, so they follow fullscreen on
        // their own (GNOME's tracking would show them again).
        Main.layoutManager.addChrome(this._island, {affectsStruts: false, trackFullscreen: true});
        for (const actor of [this._corner, ...this._bubbles])
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: false});
        this._bridge.enable(name => name === 'corner' ? this._corner.slot() : this._island.slot(name));

        this._updateStrut();
        this._settings.connectObject('changed::reserve-space', () => this._updateStrut(), this);
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

    // Tolerates any partially initialised state (also called after a failed enable()).
    disable() {
        if (this._keybound) {
            Main.wm.removeKeybinding(KEYBINDING);
            this._keybound = false;
        }
        this._settings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);

        for (const activity of this._activities?.values() ?? [])
            this._safeDisable(activity);
        this._activities?.clear();
        this._manager?.clear();

        // Off the stage first: a relayout queued while indicators leave would
        // otherwise run on actors that are already gone.
        const actors = [...this._bubbles ?? [], this._corner, this._island].filter(Boolean);
        for (const actor of actors) {
            if (actor.get_parent())
                Main.layoutManager.removeChrome(actor);
        }
        // Return borrowed indicators BEFORE destroying the island and corner,
        // or they would be destroyed with them.
        try {
            this._bridge?.disable();
        } catch (e) {
            console.error('Dynland: error while returning the top bar', e);
        }
        this._removeStrut();
        for (const actor of actors)
            actor.destroy();

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
            if (!this._bubbles.some(b => b.activity?.id === activity.id))
                free.shift().setActivity(activity);
        }
        for (const bubble of free)
            bubble.setActivity(null);
        this._island.setCompact(shown.length > 1);
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
