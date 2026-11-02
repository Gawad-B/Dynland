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
        const box = new St.BoxLayout({style_class: 'dynland-osd', x_expand: true});
        box.add_child(new St.Icon({
            gicon: icon,
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // The track fills the middle; the fill is clipped to its rounded shape.
        // natural_width must be set too: a natural width below min_width is a fatal Clutter error.
        const track = new St.Widget({
            style_class: 'dynland-level-track',
            min_width: TRACK_WIDTH,
            natural_width: TRACK_WIDTH,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        const fill = new St.Widget({style_class: 'dynland-level-fill'});
        track.add_child(fill);
        track.connect('notify::allocation', () => {
            fill.width = Math.round(track.width * ratio);
        });
        box.add_child(track);

        box.add_child(new St.Label({
            text: `${Math.round(ratio * 100)}`,
            style_class: 'dynland-level-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }
}
