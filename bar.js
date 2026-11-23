// The menu bar: an optional full-width translucent strip across the top of the
// primary monitor, like the macOS menu bar. It offers three boxes (left,
// status, clock) that borrowed GNOME panel indicators are placed into. The
// island is drawn above it as the notch, black and centred, and the bar's
// content keeps clear of the closed notch, always (a constant: whatever the
// notch is doing, nothing below it ever moves; BarRow). When a side is too
// wide for its half, whole indicators move to the other side (MenuBar)
// instead of being cut off, by their own widths only.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BarDnd} from './barDnd.js';
import {scaleFactor} from './morphBox.js';

export const BAR_HEIGHT = 32; // logical px
// The closed notch's width (stylesheet .dynland-notch min-width), logical px.
export const NOTCH_WIDTH = 180;
// Logical px kept clear between the bar's content and the notch, each side.
const NOTCH_GAP = 8;
// Logical px of slack an indicator needs to go back to its home side, and to
// be moved onto the other side: a width hovering at the limit must not make
// indicators hop between the sides.
const HYSTERESIS = 16;
// While an indicator menu is open nothing moves (moving a container unmaps
// it and closes its menu); look again this often, in ms.
const MENU_RETRY_MS = 500;

const SLOT_NAMES = ['barStart', 'barStatus', 'barClock'];

// Children laid right-aligned at their natural widths in the room the row
// gives them (the overflow from the start side, then the status icons): when
// they do not fit, those nearest the notch (the leftmost) are cut off, and
// those nearest the clock stay. That is the last resort: MenuBar moves whole
// indicators to the other side first.
const StatusClip = GObject.registerClass(
class StatusClip extends St.Widget {
    constructor(...children) {
        super({clip_to_allocation: true});
        this._children = children;
        for (const child of children)
            this.add_child(child);
    }

    vfunc_get_preferred_width(forHeight) {
        let natural = 0;
        for (const child of this._children)
            natural += child.get_preferred_width(forHeight)[1];
        return [0, natural];
    }

    vfunc_get_preferred_height(forWidth) {
        let natural = 0;
        for (const child of this._children)
            natural = Math.max(natural, child.get_preferred_height(-1)[1]);
        return [0, natural];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        let x2 = box.get_width();
        for (let i = this._children.length - 1; i >= 0; i--) {
            const child = this._children[i];
            const [, natural] = child.get_preferred_width(-1);
            const [, height] = child.get_preferred_height(natural);
            const y1 = Math.floor((box.get_height() - height) / 2);
            child.allocate(Clutter.ActorBox.new(x2 - natural, y1, x2, y1 + height));
            x2 -= natural;
        }
    }
});

// The bar's row: the start box from the left edge (the indicators that
// overflowed from the status side right after it), the clock at the right
// edge and the status icons left of it (the overflow from the start side at
// their notch end), each side stopping short of the notch in the middle.
// Placed here, in the layout itself, never by moving anything from a signal
// handler. The bar's padding is the same on both sides, so the row's middle
// is the monitor's, where the notch is. The middle kept clear is the closed
// notch (a constant) plus a gap, whatever is drawn there. After each layout it
// tells its owner (onAllocated, which only reads) so a side that no longer
// fits is noticed.
const BarRow = GObject.registerClass(
class BarRow extends St.Widget {
    constructor(start, startOver, status, statusOver, clock) {
        super({
            name: 'panel',
            style_class: 'dynland-row dynland-bar-row',
            x_expand: true,
            y_expand: true,
        });
        this._start = start;
        this._startOver = startOver;
        this._clock = clock;
        this._statusClip = new StatusClip(statusOver, status);
        // The room each side had at the last layout, in px: what an owner
        // plans the moves with. Null until the row has been laid out.
        this.rooms = null;
        this.onAllocated = null;
        // A start box squeezed below its minimum (the app name already
        // down to its ellipsis) must not draw under the notch either.
        start.clip_to_allocation = true;
        startOver.clip_to_allocation = true;
        this.add_child(start);
        this.add_child(startOver);
        this.add_child(this._statusClip);
        this.add_child(clock);
    }

    _parts() {
        return [this._start, this._startOver, this._statusClip, this._clock];
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
        // Each side may reach to half of the closed notch plus a gap from the middle.
        const clear = NOTCH_WIDTH * scale / 2 + NOTCH_GAP * scale;
        const leftEnd = Math.max(content.x1, Math.floor(middle - clear));
        const rightStart = Math.min(content.x2, Math.ceil(middle + clear));

        const place = (actor, x1, x2) => {
            const [, height] = actor.get_preferred_height(Math.max(0, x2 - x1));
            const h = Math.min(height, content.get_height());
            const y1 = Math.floor(content.y1 + (content.get_height() - h) / 2);
            actor.allocate(Clutter.ActorBox.new(x1, y1, Math.max(x1, x2), y1 + h));
        };

        // Left: the start box at its natural width, or squeezed to the room
        // there is (the app name ellipsizes), then the overflow from the
        // status side in what is left of it.
        const leftRoom = leftEnd - content.x1;
        const [, startNatural] = this._start.get_preferred_width(-1);
        const startWidth = Math.min(startNatural, leftRoom);
        place(this._start, content.x1, content.x1 + startWidth);
        const [, overNatural] = this._startOver.get_preferred_width(-1);
        const overX1 = content.x1 + startWidth;
        place(this._startOver, overX1, overX1 + Math.min(overNatural, leftRoom - startWidth));

        // Right: the clock at the edge, the status icons in what is left.
        const [, clockNatural] = this._clock.get_preferred_width(-1);
        const clockWidth = Math.min(clockNatural, content.x2 - rightStart);
        const clockX1 = content.x2 - clockWidth;
        place(this._clock, clockX1, content.x2);
        const statusEnd = Math.max(rightStart, clockWidth > 0 ? clockX1 - spacing : clockX1);
        // The clip takes the full content height; the icons centre inside it.
        this._statusClip.allocate(Clutter.ActorBox.new(rightStart, content.y1, statusEnd, content.y2));

        this.rooms = {leftRoom, statusRoom: statusEnd - rightStart};
        // Only a read of the layout, never a change to it, may follow.
        if (this.onAllocated)
            this.onAllocated();
    }
});

export const MenuBar = GObject.registerClass(
class MenuBar extends St.Widget {
    /**
     * @param {Gio.Settings} settings Dynland settings (the bar is always
     *     translucent, whatever the island's style); drag and drop writes
     *     the indicators' order to them
     * @param {object} [deps]
     * @param {() => boolean} [deps.anyMenuOpen] true while an indicator's
     *     menu is open (nothing is moved then); default: never
     */
    constructor(settings, {anyMenuOpen = () => false} = {}) {
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
        // Where indicators go when their own side is too wide: a box after
        // the start box's content (for the status side's) and one at the
        // notch end of the status side (for the start side's). Not slots:
        // nothing else adds to them, only this class moves children in.
        this._toStart = box();
        this._toStatus = box();
        // What is out of its home box: the status-side indicators in
        // _toStart and the start-side ones in _toStatus, in the order they
        // were moved, so the last is the first to go home (which puts them
        // back in their original order). Dropped when a child leaves the bar.
        this._fromStatus = [];
        this._fromStart = [];
        // Each indicator's place in its home box, {side, key}, so a moved one
        // goes back between the same neighbours and the moved ones keep
        // their order on the other side. Keys are given when the bridge adds
        // a child; one added between two takes a key between theirs.
        this._order = new Map();
        this._anyMenuOpen = anyMenuOpen;
        this._retryId = 0;
        this._laterId = 0;
        this._applying = false;
        this._destroyed = false;

        // The row is named 'panel' so GNOME's `#panel` CSS (button padding,
        // indicator styles) applies to the indicators placed in it.
        this._row = new BarRow(this._slots.barStart, this._toStart,
            this._slots.barStatus, this._toStatus, this._slots.barClock);
        this.add_child(this._row);
        // Called at the end of each layout, where nothing may be changed:
        // it only queues the move for a later.
        this._row.onAllocated = () => this._checkAfterLayout();

        // The bridge adds and removes indicators at any time.
        const boxes = [...Object.values(this._slots), this._toStart, this._toStatus];
        for (const b of boxes) {
            b.connectObject(
                'child-added', (box, child) => this._childAdded(box, child),
                'child-removed', (_box, child) => this._childRemoved(child),
                this);
        }

        // Drag and drop of the indicators (Super held); needs the boxes above.
        this._dnd = new BarDnd(settings, this);

        this.connect('destroy', () => this._onDestroy());
        Main.layoutManager.connectObject('monitors-changed', () => this.reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this.reposition(), this);
        this.reposition();
    }

    // Re-check the sides soon (coalesced). Indicators that no longer fit
    // move to the other side, those that fit at home again go back.
    rebalance() {
        this._queueRebalance();
    }

    // Drag and drop ended (dropped or cancelled): the moves held while it
    // ran (_rebalance) are looked at once now.
    dragEnded() {
        this._queueRebalance();
    }

    _onDestroy() {
        this._destroyed = true;
        this._dnd?.destroy();
        this._dnd = null;
        this._row.onAllocated = null;
        const laters = global.compositor.get_laters();
        if (this._laterId) {
            laters.remove(this._laterId);
            this._laterId = 0;
        }
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._fromStatus = [];
        this._fromStart = [];
        this._order.clear();
    }

    // One later per burst of changes, run before the next redraw and never
    // from inside a layout pass. Nothing is queued while off the stage.
    _queueRebalance() {
        if (this._laterId || this._destroyed || this._applying || !this.get_stage())
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            if (!this._destroyed && this.get_stage())
                this._rebalance();
            return GLib.SOURCE_REMOVE;
        });
    }

    // End of a layout pass: only measures. A change goes through the later.
    _checkAfterLayout() {
        if (this._laterId || this._applying || this._destroyed)
            return;
        const ops = this._plan();
        if (ops && ops.length > 0)
            this._queueRebalance();
    }

    // A menu is open: look again later, without moving anything now.
    _retryWhenMenusClosed() {
        if (this._retryId || this._destroyed)
            return;
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_RETRY_MS, () => {
            this._retryId = 0;
            this._queueRebalance();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A child was added (by the bridge; ours are ignored). One in a home box
    // gets its place in that side's order.
    _childAdded(box, child) {
        if (this._applying || this._destroyed)
            return;
        const side = box === this._slots.barStart ? 'start'
            : box === this._slots.barStatus ? 'status' : null;
        if (side)
            this._assignOrder(side, box, child);
        this._queueRebalance();
    }

    // A key between the nearest neighbours that have one; at an end, past
    // every key of that side (moved-away indicators included).
    _assignOrder(side, box, child) {
        const kids = box.get_children();
        const index = kids.indexOf(child);
        const keyAt = i => {
            const entry = this._order.get(kids[i]);
            return entry?.side === side ? entry.key : null;
        };
        let prev = null;
        for (let i = index - 1; i >= 0 && prev === null; i--)
            prev = keyAt(i);
        let next = null;
        for (let i = index + 1; i < kids.length && next === null; i++)
            next = keyAt(i);
        const keys = [...this._order.values()].filter(e => e.side === side).map(e => e.key);
        let key;
        if (prev !== null && next !== null)
            key = (prev + next) / 2;
        else if (next !== null)
            key = Math.min(next, ...keys) - 1;
        else if (prev !== null)
            key = Math.max(prev, ...keys) + 1;
        else
            key = keys.length ? Math.max(...keys) + 1 : 0;
        this._order.set(child, {side, key});
    }

    // Where `child` goes in `box` so the box's children stay in home order.
    _indexByOrder(box, child) {
        const key = this._order.get(child)?.key;
        if (key === undefined)
            return undefined;
        const kids = box.get_children();
        const index = kids.findIndex(c => (this._order.get(c)?.key ?? -Infinity) > key);
        return index === -1 ? undefined : index;
    }

    // A child left a box. If it was one of the moved ones it is not ours
    // any more (its owner removed it, or it was destroyed): drop the record.
    _childRemoved(child) {
        if (this._applying || this._destroyed)
            return;
        this._fromStatus = this._fromStatus.filter(c => c !== child);
        this._fromStart = this._fromStart.filter(c => c !== child);
        this._order.delete(child);
        this._queueRebalance();
    }

    // The moves that make each side fit, as a list of {kind, child}, from
    // the widths now and the room each side had at the last layout. Only
    // reads. Item widths are natural widths plus the box spacing.
    //   homeStart / homeStatus: an indicator goes back, if it fits there
    //     with HYSTERESIS to spare (the last one moved first);
    //   toStatus: a start-side indicator, last first, never the first child
    //     (the app name), if the status side has room for it (one that does
    //     not fit is passed over for the next);
    //   toStart: a status-side indicator, first first, if the start side
    //     has room for it (likewise).
    // Indicators already moved are never moved on, so nothing goes back and
    // forth; when the other side has no room the side is left to clip.
    _plan() {
        const rooms = this._row.rooms;
        if (!rooms)
            return null;
        const margin = HYSTERESIS * scaleFactor();
        const width = c => c.get_preferred_width(-1)[1];
        const gap = b => b.layout_manager.spacing || 0;
        const {barStart, barStatus} = this._slots;
        const startGap = gap(barStart);
        const statusGap = gap(barStatus);
        let startUsed = width(barStart) + width(this._toStart);
        let statusUsed = width(barStatus) + width(this._toStatus);
        const ops = [];

        const fromStart = [...this._fromStart];
        while (fromStart.length > 0) {
            const child = fromStart[fromStart.length - 1];
            const w = child.visible ? width(child) : 0;
            const startDelta = w > 0 ? w + startGap : 0;
            if (startDelta > 0 && startUsed + startDelta + margin > rooms.leftRoom)
                break;
            fromStart.pop();
            ops.push({kind: 'homeStart', child});
            startUsed += startDelta;
            statusUsed -= w > 0 ? w + statusGap : 0;
        }
        const fromStatus = [...this._fromStatus];
        while (fromStatus.length > 0) {
            const child = fromStatus[fromStatus.length - 1];
            const w = child.visible ? width(child) : 0;
            const statusDelta = w > 0 ? w + statusGap : 0;
            if (statusDelta > 0 && statusUsed + statusDelta + margin > rooms.statusRoom)
                break;
            fromStatus.pop();
            ops.push({kind: 'homeStatus', child});
            statusUsed += statusDelta;
            startUsed -= w > 0 ? w + startGap : 0;
        }

        // Start side too wide: from its notch end, never the app name.
        if (startUsed > rooms.leftRoom) {
            const kids = barStart.get_children().slice(1);
            for (let i = kids.length - 1; i >= 0 && startUsed > rooms.leftRoom; i--) {
                const child = kids[i];
                if (!child.visible)
                    continue;
                const w = width(child);
                if (statusUsed + w + statusGap + margin > rooms.statusRoom)
                    continue;
                ops.push({kind: 'toStatus', child});
                startUsed -= w + startGap;
                statusUsed += w + statusGap;
            }
        }
        // Status side too wide: from its notch end (the first children).
        if (statusUsed > rooms.statusRoom) {
            const kids = barStatus.get_children();
            for (let i = 0; i < kids.length && statusUsed > rooms.statusRoom; i++) {
                const child = kids[i];
                if (!child.visible)
                    continue;
                const w = width(child);
                if (startUsed + w + startGap + margin > rooms.leftRoom)
                    continue;
                ops.push({kind: 'toStart', child});
                statusUsed -= w + statusGap;
                startUsed += w + startGap;
            }
        }
        return ops;
    }

    // Runs from the later, outside any layout pass. Nothing moves while an
    // indicator menu is open; it looks again once they are closed. Nothing
    // moves during a drag either (the drop place is read from the boxes as
    // they are): BarDnd calls dragEnded() when it is over.
    _rebalance() {
        if (this._dnd?.dragging)
            return;
        const ops = this._plan();
        if (!ops || ops.length === 0)
            return;
        if (this._anyMenuOpen()) {
            this._retryWhenMenusClosed();
            return;
        }
        const {barStart, barStatus} = this._slots;
        // Every box keeps its children in home order.
        const move = (child, to) => {
            const from = child.get_parent();
            if (from)
                from.remove_child(child);
            const index = this._indexByOrder(to, child);
            if (index === undefined)
                to.add_child(child);
            else
                to.insert_child_at_index(child, index);
        };
        // The bridge must not be fought: our own moves are not changes to
        // react to, but anything it does afterwards is.
        this._applying = true;
        try {
            for (const {kind, child} of ops) {
                switch (kind) {
                case 'homeStart':
                    this._fromStart = this._fromStart.filter(c => c !== child);
                    move(child, barStart);
                    break;
                case 'homeStatus':
                    this._fromStatus = this._fromStatus.filter(c => c !== child);
                    move(child, barStatus);
                    break;
                case 'toStatus':
                    this._fromStart.push(child);
                    move(child, this._toStatus);
                    break;
                case 'toStart':
                    this._fromStatus.push(child);
                    move(child, this._toStart);
                    break;
                }
            }
        } finally {
            this._applying = false;
        }
    }

    /**
     * The boxes drag and drop reads, in visual order: start, toStart (status
     * indicators the overflow moved to the start side), toStatus (start-side
     * ones moved to the status side), status, and the clock's.
     */
    dndBoxes() {
        return {
            start: this._slots.barStart,
            toStart: this._toStart,
            toStatus: this._toStatus,
            status: this._slots.barStatus,
            clock: this._slots.barClock,
        };
    }

    slot(name) {
        if (!SLOT_NAMES.includes(name))
            throw new Error(`Unknown menu bar slot: ${name}`);
        return this._slots[name];
    }

    // The primary monitor's full width, at the origin of its parent (BarMotion's
    // clip, which sits on the monitor's top-left corner). Called from signal
    // handlers only, never from inside this actor's own allocation.
    reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.set_position(0, 0);
        this.set_size(monitor.width, Math.round(BAR_HEIGHT * scaleFactor()));
    }
});
