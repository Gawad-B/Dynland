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
import * as Notifications from './activities/notifications.js';
import * as Osd from './activities/osd.js';
import * as Power from './activities/power.js';

// Settings key → [activity id, activity class]
const ACTIVITIES = {
    'activity-notifications': [Notifications.ID, Notifications.NotificationsActivity],
    'activity-osd': [Osd.ID, Osd.OsdActivity],
    'activity-power': [Power.ID, Power.PowerActivity],
};

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

        this._bridge.enable(this._island);
        Main.layoutManager.addChrome(this._island, {affectsStruts: false, trackFullscreen: true});

        this._updateStrut();
        this._settings.connectObject('changed::reserve-space', () => this._updateStrut(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._updateStrut(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._updateStrut(), this);

        for (const key of Object.keys(ACTIVITIES)) {
            this._syncActivity(key);
            this._settings.connectObject(`changed::${key}`, () => this._syncActivity(key), this);
        }

        Main.wm.addKeybinding('toggle-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._island.toggleExpanded());
        this._keybound = true;
    }

    // Tolerates any partially initialised state (also called after a failed enable()).
    disable() {
        if (this._keybound) {
            Main.wm.removeKeybinding('toggle-shortcut');
            this._keybound = false;
        }
        this._settings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);

        for (const activity of this._activities?.values() ?? [])
            this._safeDisable(activity);
        this._activities?.clear();
        this._manager?.clear();

        // Return borrowed indicators BEFORE destroying the island, or they
        // would be destroyed with it.
        try {
            this._bridge?.disable();
        } catch (e) {
            console.error('Dynland: error while returning the top bar', e);
        }
        this._removeStrut();
        if (this._island) {
            if (this._island.get_parent())
                Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
        }

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
