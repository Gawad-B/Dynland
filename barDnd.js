// Drag and drop on the bar: with Super held, press an indicator and drag it
// to a new place, on either side of the notch. A thin marker shows where it
// will land; on drop the new arrangement is written to settings
// (bar-start-indicators, bar-status-order) and the panel bridge lays the bar
// out again from them. The app-name button, the workspace dots and the clock
// are fixed: nothing is dropped before them or after the clock.
//
// The drag is self-contained (no GNOME DnD helper): a press with Super held on
// an indicator is swallowed and becomes "pending"; moving past a threshold
// starts the drag, which holds a modal grab (Escape cancels), shows a clone
// of the indicator at the pointer and a marker on the bar. The indicators
// themselves never move during the drag (the bar holds its overflow moves
// until it ends, MenuBar.dragEnded), so nothing is laid out again until the
// drop, and then only by the bridge from the new settings. Anything else
// changing the bar's boxes meanwhile (the bridge laying the bar out again),
// or the indicator or our grab actor going away, cancels the drag.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {mergeBarLists} from './lib/layout.js';
import {scaleFactor} from './morphBox.js';

// Logical px the pointer must move with the button down before a drag starts.
const DRAG_THRESHOLD = 8;
const SUPER_MASK = Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;
const DRAGGED_OPACITY = 90;
const CLONE_OPACITY = 210;
const MARKER_WIDTH = 2;
const MARKER_STYLE = `width: ${MARKER_WIDTH}px; height: 18px; border-radius: 1px; ` +
    'background-color: rgba(255, 255, 255, 0.95); ' +
    'box-shadow: 0 0 4px rgba(0, 0, 0, 0.6);';

export class BarDnd {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {MenuBar} bar the bar; must offer dndBoxes()
     */
    constructor(settings, bar) {
        this._settings = settings;
        this._bar = bar;
        this._boxes = bar.dndBoxes();
        this._pending = null;
        this._drag = null;
        this._destroyed = false;
        bar.connectObject('captured-event', (_actor, event) => this._onBarEvent(event), this);
    }

    destroy() {
        this._destroyed = true;
        this._clearPending();
        this._endDrag();
        this._bar.disconnectObject(this);
    }

    /** True from the start of a drag to its end (drop or cancel). */
    get dragging() {
        return this._drag !== null;
    }

    // ---- press, pending ----

    _onBarEvent(event) {
        if (this._destroyed || this._pending || this._drag || !this._bar.get_stage())
            return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.BUTTON_PRESS ||
            event.get_button() !== Clutter.BUTTON_PRIMARY ||
            !(event.get_state() & SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;

        const unit = this._unitAt(event.get_source());
        if (!unit)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const [ax, ay] = unit.actor.get_transformed_position();
        this._pending = {actor: unit.actor, x, y, offset: [x - ax, y - ay]};
        global.stage.connectObject('captured-event',
            (_stage, ev) => this._onPendingEvent(ev), this);
        // The press must not also open the indicator's menu.
        return Clutter.EVENT_STOP;
    }

    _clearPending() {
        if (!this._pending)
            return;
        this._pending = null;
        global.stage.disconnectObject(this);
    }

    _onPendingEvent(event) {
        const pending = this._pending;
        if (!pending || this._destroyed)
            return Clutter.EVENT_PROPAGATE;
        switch (event.type()) {
        case Clutter.EventType.MOTION: {
            if (!(event.get_state() & SUPER_MASK) || !this._bar.get_stage() ||
                !pending.actor.get_stage()) {
                this._clearPending();
                return Clutter.EVENT_PROPAGATE;
            }
            const [x, y] = event.get_coords();
            if (Math.hypot(x - pending.x, y - pending.y) >= DRAG_THRESHOLD * scaleFactor()) {
                this._clearPending();
                this._startDrag(pending, x, y);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        case Clutter.EventType.BUTTON_RELEASE:
            // A Super-click without a drag does nothing (and opens nothing).
            this._clearPending();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    // ---- roles and units ----

    _roles() {
        const roles = new Map();
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            // Some extensions null an entry out before re-adding it.
            if (indicator?.container)
                roles.set(indicator.container, role);
        }
        return roles;
    }

    // The visual units of the bar's row, left to right: {actor, actors, role,
    // left (before the notch), home ('start' | 'status'), visible, x1, x2}.
    // A unit is one indicator container, with the extra item other code puts
    // right before Quick Settings travelling with it; a child with no role
    // (and not such an extra) is a unit with role null: fixed, kept in the
    // geometry but never written to settings. Fixed leading children (the
    // app-name button, the workspace dots) are not units: `fixedEnd` is where
    // they end; the workspace dots moved to the status side by the overflow
    // are not a unit either (never dragged, never written).
    // Read-only: safe to call from event handlers.
    _collect() {
        const roles = this._roles();
        const {start, toStart, toStatus, status} = this._boxes;
        const groups = [
            [start, true, 'start'],
            [toStart, true, 'status'],
            [toStatus, false, 'start'],
            [status, false, 'status'],
        ];
        const units = [];
        let fixedEnd = this._bar.get_transformed_position()[0];
        for (const [box, left, home] of groups) {
            const kids = box.get_children();
            let extras = [];
            kids.forEach((kid, i) => {
                const role = roles.get(kid) ?? null;
                if (box === start && (i === 0 || role === 'activities')) {
                    const [x] = kid.get_transformed_position();
                    const [w] = kid.get_transformed_size();
                    fixedEnd = Math.max(fixedEnd, x + w);
                    return;
                }
                if (role === 'activities')
                    return;
                if (!role) {
                    const next = kid.get_next_sibling();
                    if (next && roles.get(next) === 'quickSettings') {
                        extras.push(kid);
                        return;
                    }
                }
                const actors = [...extras, kid];
                extras = [];
                const [x1] = actors[0].get_transformed_position();
                const [lx] = kid.get_transformed_position();
                const [lw] = kid.get_transformed_size();
                units.push({
                    actor: kid, actors, role, left, home,
                    visible: kid.visible && lw > 0,
                    x1, x2: lx + lw,
                });
            });
        }
        return {units, fixedEnd, roles};
    }

    // The role unit a press landed on: the bar's box child containing `source`.
    _unitAt(source) {
        const {start, toStart, toStatus, status} = this._boxes;
        const boxes = [start, toStart, toStatus, status];
        let actor = source;
        while (actor && actor !== this._bar) {
            const parent = actor.get_parent();
            if (boxes.includes(parent))
                break;
            actor = parent;
        }
        if (!actor || actor === this._bar)
            return null;
        return this._collect().units.find(u => u.role && u.actor === actor) ?? null;
    }

    // ---- the drag ----

    _startDrag(pending, x, y) {
        if (this._destroyed || !this._bar.get_stage() || !pending.actor.get_stage())
            return;
        // An open menu would stay up (and its grab would fight ours).
        for (const indicator of Object.values(Main.panel.statusArea)) {
            try {
                if (indicator?.menu?.isOpen)
                    indicator.menu.close();
            } catch (e) {
                logError(e, 'Dynland: closing an indicator menu for a drag');
            }
        }

        const drag = {
            actor: pending.actor,
            offset: pending.offset,
            opacity: pending.actor.opacity,
            handler: null, grab: null, clone: null, marker: null,
            target: null,
        };
        try {
            drag.handler = new Clutter.Actor({width: 0, height: 0, reactive: true});
            Main.uiGroup.add_child(drag.handler);
            drag.handler.connect('event', (_actor, event) => this._onDragEvent(event));
            drag.grab = Main.pushModal(drag.handler);

            const [w, h] = pending.actor.get_transformed_size();
            drag.clone = new Clutter.Clone({
                source: pending.actor, width: w, height: h,
                opacity: CLONE_OPACITY, reactive: false,
            });
            Main.uiGroup.add_child(drag.clone);

            drag.marker = new St.Widget({
                style_class: 'dynland-bar-drop-marker',
                style: MARKER_STYLE,
                reactive: false,
                visible: false,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._bar.add_child(drag.marker);
        } catch (e) {
            logError(e, 'Dynland: starting a bar drag');
            this._drag = drag;
            this._endDrag();
            return;
        }

        for (const key of ['handler', 'clone', 'marker']) {
            const actor = drag[key];
            actor.connect('destroy', () => {
                if (drag[key] !== actor)
                    return; // Ours, from _endDrag.
                drag[key] = null;
                if (key === 'handler') {
                    // GNOME pops the modal of a destroyed actor itself
                    // (pushModal's destroy handler, connected before this
                    // one): popping it again would be an 'incorrect pop'.
                    drag.grab = null;
                    if (this._drag === drag)
                        this._endDrag();
                }
            });
        }
        this._drag = drag;
        // The indicator going away cancels the drag, and so does any child
        // coming or going in the bar's boxes (the bridge laying the bar out
        // again, or an indicator added): the drop place would be stale.
        // Only grab, clone and marker go; nothing in the bar is moved here.
        pending.actor.connectObject('destroy', () => this._endDrag(), this);
        const {start, toStart, toStatus, status, clock} = this._boxes;
        for (const box of [start, toStart, toStatus, status, clock]) {
            box.connectObject(
                'child-added', () => this._endDrag(),
                'child-removed', () => this._endDrag(), this);
        }
        pending.actor.opacity = DRAGGED_OPACITY;

        this._update(x, y);
    }

    _onDragEvent(event) {
        if (!this._drag || this._destroyed)
            return Clutter.EVENT_PROPAGATE;
        switch (event.type()) {
        case Clutter.EventType.MOTION: {
            const [x, y] = event.get_coords();
            this._update(x, y);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_RELEASE: {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;
            const [x, y] = event.get_coords();
            this._drop(x, y);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.KEY_PRESS:
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this._endDrag();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.KEY_RELEASE:
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    // Pointer moved: the clone follows, the marker shows the drop place (and
    // hides outside the bar, where a drop would cancel).
    _update(x, y) {
        const drag = this._drag;
        if (!drag)
            return;
        if (!this._bar.get_stage() || !drag.actor.get_stage()) {
            this._endDrag();
            return;
        }
        drag.clone?.set_position(x - drag.offset[0], y - drag.offset[1]);
        const target = this._target(this._collect(), drag.actor, x, y);
        drag.target = target;
        if (drag.marker) {
            if (target) {
                const [bx] = this._bar.get_transformed_position();
                drag.marker.translation_x = Math.round(target.x - bx - MARKER_WIDTH / 2);
                drag.marker.visible = true;
            } else {
                drag.marker.visible = false;
            }
        }
    }

    // Where a drop at (px, py) lands: {left, k, x}: `left` the side of the
    // notch, `k` the index in the visual order of the units without the
    // dragged one, `x` the marker's stage x. Null outside the bar.
    _target({units, fixedEnd}, dragActor, px, py) {
        const [bx, by] = this._bar.get_transformed_position();
        const [bw, bh] = this._bar.get_transformed_size();
        if (px < bx || px >= bx + bw || py < by || py >= by + bh)
            return null;

        const rest = units.filter(u => u.actor !== dragActor);
        const left = px < bx + bw / 2;
        const leftCount = rest.filter(u => u.left).length;
        const visible = rest.filter(u => u.left === left && u.visible);
        const [clockX] = this._boxes.clock.get_transformed_position();
        const candidates = [];
        if (visible.length === 0) {
            candidates.push({k: left ? leftCount : rest.length,
                x: left ? fixedEnd : clockX - 4});
        } else {
            visible.forEach((u, i) => {
                const prevEdge = i > 0 ? visible[i - 1].x2 : (left ? fixedEnd : null);
                candidates.push({
                    k: rest.indexOf(u),
                    x: prevEdge === null ? u.x1 - 2 : (prevEdge + u.x1) / 2,
                });
            });
            const last = visible[visible.length - 1];
            candidates.push({
                k: left ? leftCount : rest.length,
                x: left ? last.x2 + 2 : (last.x2 + clockX) / 2,
            });
        }
        let best = candidates[0];
        for (const c of candidates) {
            if (Math.abs(c.x - px) < Math.abs(best.x - px))
                best = c;
        }
        return {left, k: best.k, x: best.x};
    }

    // The final arrangement as role lists: `start` and `status`. The units
    // keep their visual order with the dragged one inserted at `target.k`;
    // each indicator counts for its home side (the start-side ones the
    // overflow moved to the status side, and the other way round, go back),
    // the dragged one for the side it was dropped on. Without a drag or
    // target, the arrangement as it is.
    _arrangement(units, dragActor, target) {
        let order = units;
        let dragged = null;
        if (dragActor && target) {
            const rest = units.filter(u => u.actor !== dragActor);
            const unit = units.find(u => u.actor === dragActor);
            dragged = {...unit, home: target.left ? 'start' : 'status'};
            order = [...rest];
            order.splice(target.k, 0, dragged);
        }
        const rolesOf = home => order.filter(u => u.role && u.home === home).map(u => u.role);
        return {start: rolesOf('start'), status: rolesOf('status')};
    }

    _drop(x, y) {
        const drag = this._drag;
        if (!drag)
            return;
        const collected = this._collect();
        const target = this._target(collected, drag.actor, x, y);
        const dragged = collected.units.find(u => u.actor === drag.actor);
        // Always over (grab released, clone and marker gone, the indicator's
        // opacity back) before the settings change makes the bridge relayout.
        this._endDrag();
        if (!target || !dragged || this._destroyed)
            return;

        const before = this._arrangement(collected.units, null, null);
        const after = this._arrangement(collected.units, drag.actor, target);
        const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
        if (same(before.start, after.start) && same(before.status, after.status))
            return;

        // Merged into the lists as they are: entries for indicators not on
        // the bar now, and wildcards the drop does not disturb, stay.
        const lists = {
            start: this._settings.get_strv('bar-start-indicators'),
            status: this._settings.get_strv('bar-status-order'),
        };
        const merged = mergeBarLists(lists, before, after, dragged.role);
        if (same(merged.start, lists.start) && same(merged.status, lists.status))
            return;
        this._settings.delay();
        try {
            if (!same(merged.start, lists.start))
                this._settings.set_strv('bar-start-indicators', merged.start);
            if (!same(merged.status, lists.status))
                this._settings.set_strv('bar-status-order', merged.status);
        } finally {
            this._settings.apply();
        }
    }

    // Ends the drag, however it ended (a drop, or a cancel). Safe to call
    // twice and from any state; only takes away the drag's own actors.
    _endDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        drag.actor.disconnectObject(this);
        for (const box of Object.values(this._boxes))
            box.disconnectObject(this);
        // The bridge may have destroyed the actor; reparenting is harmless.
        if (drag.actor.get_stage())
            drag.actor.opacity = drag.opacity;
        if (drag.grab) {
            try {
                Main.popModal(drag.grab);
            } catch (e) {
                logError(e, 'Dynland: releasing the bar drag grab');
            }
            drag.grab = null;
        }
        for (const key of ['marker', 'clone', 'handler']) {
            const actor = drag[key];
            drag[key] = null;
            actor?.destroy();
        }
        // The overflow moves held during the drag may run now (once).
        if (!this._destroyed)
            this._bar.dragEnded?.();
    }
}
