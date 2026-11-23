// The menu bar: an optional full-width translucent strip across the top of the
// primary monitor, like the macOS menu bar. It offers three boxes (left,
// status, clock) that borrowed GNOME panel indicators are placed into. The
// island is drawn above it as the notch, black and centred, and the bar's
// content keeps clear of it (BarRow).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {scaleFactor} from './morphBox.js';

export const BAR_HEIGHT = 32; // logical px
// The closed notch's width (stylesheet .dynland-notch min-width), logical px.
export const NOTCH_WIDTH = 180;
// Logical px kept clear between the bar's content and the notch, each side.
const NOTCH_GAP = 8;

const SLOT_NAMES = ['barStart', 'barStatus', 'barClock'];

// The status icons, right-aligned at their natural width and clipped to
// whatever room the row gives them: when they do not fit, those nearest the
// notch are cut off, and those nearest the clock stay.
const StatusClip = GObject.registerClass(
class StatusClip extends St.Widget {
    constructor(child) {
        super({clip_to_allocation: true});
        this._child = child;
        this.add_child(child);
    }

    vfunc_get_preferred_width(forHeight) {
        const [, natural] = this._child.get_preferred_width(forHeight);
        return [0, natural];
    }

    vfunc_get_preferred_height(forWidth) {
        return this._child.get_preferred_height(-1);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width();
        const [, natural] = this._child.get_preferred_width(-1);
        const [, height] = this._child.get_preferred_height(natural);
        const y1 = Math.floor((box.get_height() - height) / 2);
        this._child.allocate(Clutter.ActorBox.new(width - natural, y1, width, y1 + height));
    }
});

// The bar's row: the start box from the left edge, the clock at the right
// edge and the status icons left of it, each side stopping short of the
// notch in the middle. Placed here, in the layout itself, never by moving
// anything from a signal handler. The bar's padding is the same on both
// sides, so the row's middle is the monitor's, where the notch is.
const BarRow = GObject.registerClass(
class BarRow extends St.Widget {
    constructor(start, status, clock) {
        super({
            name: 'panel',
            style_class: 'dynland-row dynland-bar-row',
            x_expand: true,
            y_expand: true,
        });
        this._start = start;
        this._status = status;
        this._clock = clock;
        this._statusClip = new StatusClip(status);
        // A start box squeezed below its minimum (the app name already
        // down to its ellipsis) must not draw under the notch either.
        start.clip_to_allocation = true;
        this.add_child(start);
        this.add_child(this._statusClip);
        this.add_child(clock);
    }

    _parts() {
        return [this._start, this._statusClip, this._clock];
    }

    vfunc_get_preferred_width(forHeight) {
        let natural = 0;
        for (const part of this._parts())
            natural += part.get_preferred_width(forHeight)[1];
        return this.get_theme_node().adjust_preferred_width(0, natural);
    }

    vfunc_get_preferred_height(forWidth) {
        let [min, natural] = [0, 0];
        for (const part of this._parts()) {
            const [partMin, partNatural] = part.get_preferred_height(-1);
            min = Math.max(min, partMin);
            natural = Math.max(natural, partNatural);
        }
        return this.get_theme_node().adjust_preferred_height(min, natural);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const node = this.get_theme_node();
        const content = node.get_content_box(box);
        const spacing = node.get_length('spacing');
        const scale = scaleFactor();
        const middle = box.get_width() / 2;
        // Each side may reach to half the closed notch plus a gap from the middle.
        const clear = (NOTCH_WIDTH / 2 + NOTCH_GAP) * scale;
        const leftEnd = Math.max(content.x1, Math.floor(middle - clear));
        const rightStart = Math.min(content.x2, Math.ceil(middle + clear));

        const place = (actor, x1, x2) => {
            const [, height] = actor.get_preferred_height(Math.max(0, x2 - x1));
            const h = Math.min(height, content.get_height());
            const y1 = Math.floor(content.y1 + (content.get_height() - h) / 2);
            actor.allocate(Clutter.ActorBox.new(x1, y1, Math.max(x1, x2), y1 + h));
        };

        // Left: the start box at its natural width, or squeezed to the room
        // there is (the app name ellipsizes).
        const [, startNatural] = this._start.get_preferred_width(-1);
        place(this._start, content.x1, content.x1 + Math.min(startNatural, leftEnd - content.x1));

        // Right: the clock at the edge, the status icons in what is left.
        const [, clockNatural] = this._clock.get_preferred_width(-1);
        const clockWidth = Math.min(clockNatural, content.x2 - rightStart);
        const clockX1 = content.x2 - clockWidth;
        place(this._clock, clockX1, content.x2);
        const statusEnd = Math.max(rightStart, clockWidth > 0 ? clockX1 - spacing : clockX1);
        // The clip takes the full content height; the icons centre inside it.
        this._statusClip.allocate(Clutter.ActorBox.new(rightStart, content.y1, statusEnd, content.y2));
    }
});

export const MenuBar = GObject.registerClass(
class MenuBar extends St.Widget {
    /**
     * @param {Gio.Settings} settings Dynland settings. Unused: the bar is
     *     always translucent, whatever the island's style.
     */
    constructor(settings) {
        super({
            name: 'dynlandBar',
            style_class: 'dynland-bar',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });

        // Each slot is centred in the 32px bar at its natural height, so an
        // indicator never stretches to, or past, its edges.
        const box = () => new St.BoxLayout({style_class: 'dynland-slot'});
        this._slots = {
            barStart: box(),
            barStatus: box(),
            barClock: box(),
        };
        // The row is named 'panel' so GNOME's `#panel` CSS (button padding,
        // indicator styles) applies to the indicators placed in it.
        this._row = new BarRow(this._slots.barStart, this._slots.barStatus, this._slots.barClock);
        this.add_child(this._row);

        Main.layoutManager.connectObject('monitors-changed', () => this.reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this.reposition(), this);
        this.reposition();
    }

    slot(name) {
        if (!SLOT_NAMES.includes(name))
            throw new Error(`Unknown menu bar slot: ${name}`);
        return this._slots[name];
    }

    // Top-left of the primary monitor, its full width. Called from signal
    // handlers only, never from inside this actor's own allocation.
    reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.set_position(monitor.x, monitor.y);
        this.set_size(monitor.width, Math.round(BAR_HEIGHT * scaleFactor()));
    }
});
