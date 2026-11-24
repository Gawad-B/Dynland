// The activity bubble: a small pill that splits off beside the island to show
// a live activity (music, a notification, volume...), so the island itself
// stays usable. Hovering or clicking it opens the activity's expanded card.
//
// Placement (fixed per bubble, chosen by the extension per layout):
//   'beside'   right of the island (or of the previous bubble); the island layout.
//   'notch'    bar layout: drawn exactly over the island, which stays the plain
//              empty notch underneath. Centred on the monitor, flush with the
//              top, never smaller than the closed notch, bar-high while compact,
//              notch corners (flat top, round bottom). Hover or click opens the
//              expanded card downward from it. It never fades or scales: it
//              appears already opaque at exactly the closed notch's size and
//              its width and height morph to the activity's size, and back to
//              the closed notch (then it hides) when the activity ends, so the
//              notch itself seems to grow and shrink.
//   'dropdown' bar layout: a card centred under the bar with a small gap,
//              showing the expanded card if the activity has one (else the
//              compact row), fully rounded. Hovering only holds its timeout.
// Notch and dropdown are centred in vfunc_allocate, as part of the layout
// (like the island), never by moving them from a width handler.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BAR_HEIGHT, NOTCH_WIDTH} from './bar.js';
import {
    CONTENT_IN_DELAY_MS, CONTENT_IN_MS, CONTENT_IN_SCALE, CONTENT_OUT_MS, EXPANDED_RADIUS, MORPH_MS,
    MorphBox, TOP_MARGIN, scaleFactor,
} from './morphBox.js';

const GAP = 8; // logical px between the island and the bubble
// The island's empty pill (stylesheet .dynland-bare) is 80x24 with no padding;
// the bubble keeps its 2px vertical padding, so its row is 20 high. As the
// menu bar's notch (.dynland-notch) the island is BAR_HEIGHT high instead.
const BARE_WIDTH = 80;
const BARE_HEIGHT = 24;
const BARE_PADDING = 2;
const POP_IN_MS = 220;
const POP_OUT_MS = 140;
const POP_SCALE = 0.4;
// The notch bubble does not pop: its content fades in like MorphBox's own
// state change (its timings), while the shape morphs from the closed notch.
// Safety net: a leaving notch that has not hidden this long after its
// content-out and morph should have ended is hidden anyway.
const NOTCH_LEAVE_MARGIN_MS = 500;
const DROPDOWN_GAP = 6; // logical px between the bar and a dropdown card
const SLIDE_MS = 200;

export const Bubble = GObject.registerClass({
    Signals: {
        // Emitted when the pointer starts (true) or stops (false) holding the
        // live activity with this id open, so its timeout can pause.
        'activity-hover': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]},
    },
}, class Bubble extends MorphBox {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {Island} island the bubble is as tall as the island
     * @param {?Bubble} previous the bubble sits right of this one while it
     *   shows, otherwise right of the island
     * @param {object} deps
     * @param {(id: string, error: Error) => void} deps.onActivityError
     * @param {'beside'|'notch'|'dropdown'} [deps.placement] see the file comment
     */
    constructor(settings, island, previous, {onActivityError, placement = 'beside'}) {
        super(settings, {
            name: 'dynlandBubble',
            style_class: placement === 'notch' ? 'dynland-bubble dynland-bubble-notch' : 'dynland-bubble',
            visible: false,
        });

        this._placement = placement;
        this._fixedY = null; // notch and dropdown: the top edge last set
        this._island = island;
        this._previous = previous;
        this._anchor = null;
        this._slideTo = null; // x the bubble is sliding to, null when still
        this._heldId = null;
        this._autoOpen = false;
        this._onActivityError = onActivityError;
        this._activity = null;
        this._activityExpanded = false;
        this._poppingOut = false;
        this._wanted = false; // shown, unless a fullscreen window hides it
        this._fullscreenHidden = false; // AutoHide: slid out for fullscreen
        this._bare = false;
        this._bareHeight = BARE_HEIGHT; // logical px, of the island's closed state
        this._bareScale = 0; // the scale the compact row's height was set at
        this._errorSources = new Set();
        this._leaveLaterId = 0; // notch: the deferred "has it reached the closed notch" check
        this._leaveWatchdogId = 0;

        // The compact row is named 'panel' so it is exactly as tall as the island's rows.
        this._compactBin = new St.Bin({
            name: 'panel',
            style_class: 'dynland-row dynland-activity',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            // Closed notch: the content sits in the middle of it.
            ...(placement === 'notch' ? {x_align: Clutter.ActorAlign.CENTER} : {}),
        });
        this._expandedBin = new St.Bin({style_class: 'dynland-activity', visible: false});
        this.add_child(this._compactBin);
        this.add_child(this._expandedBin);
        this._initContainers();
        // Beside: pops out of the island's side. Notch and dropdown grow from the top centre.
        this.pivot_point = placement === 'beside'
            ? new Graphene.Point({x: 0, y: 0.5})
            : new Graphene.Point({x: 0.5, y: 0});

        this._clickGesture = new Clutter.ClickGesture();
        // A dropdown card is already open; clicking its empty space does nothing.
        this._clickGesture.connect('recognize', () => {
            if (this._placement !== 'dropdown')
                this._setActivityExpanded(!this._activityExpanded);
        });
        this.add_action_full('dynland-bubble-toggle', Clutter.EventPhase.TARGET, this._clickGesture);

        // The island notifies these mid-layout; following it right there
        // would leave the bubble without an allocation (and undrawn) for a frame.
        this._followId = 0;
        // Only a bubble beside the island follows it (and the bubble before it).
        for (const actor of placement === 'beside' ? [island, previous].filter(Boolean) : []) {
            actor.connectObject(
                'notify::x', () => this._queueFollow(),
                'notify::y', () => this._queueFollow(),
                'notify::width', () => this._queueFollow(),
                'notify::height', () => this._queueFollow(),
                'notify::visible', () => this._queueFollow(),
                'notify::style-class', () => this._syncBare(), this);
        }
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            if (this._followId)
                global.compositor.get_laters().remove(this._followId);
            this._followId = 0;
            this._cancelLeaveWatch();
            for (const id of this._errorSources)
                GLib.source_remove(id);
            this._errorSources.clear();
        });
    }

    /** @type {?{id: string, content: object}} */
    get activity() {
        return this._activity;
    }

    /** @type {'beside'|'notch'|'dropdown'} */
    get placement() {
        return this._placement;
    }

    // Where the left edge is drawn (it centres itself in vfunc_allocate, so
    // its `x` is meaningless): the allocation, else the same centring.
    get drawnX() {
        if (this.has_allocation())
            return this.get_allocation_box().x1;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._live())
            return this.x;
        return Math.floor(monitor.x + (monitor.width - this.width) / 2);
    }

    /** AutoHide: true once slid off the top for a fullscreen window, false when it returns. */
    setFullscreenHidden(hidden) {
        this._fullscreenHidden = hidden;
        this._syncVisible();
    }

    _syncVisible() {
        this.visible = this._wanted && !this._fullscreenHidden;
        // A notch shrinking away that gets hidden (fullscreen) has nothing
        // left to show: finish now, its transitions may not advance unmapped.
        if (this._placement === 'notch' && this._poppingOut && !this._activity && !this.visible)
            this._clearPop();
    }

    /** @param {?{id: string, content: object}} current from ActivityManager */
    setActivity(current) {
        const wasShown = !!this._activity;
        if (!current)
            this._autoOpen = false;
        if (this._heldId && this._heldId !== current?.id) {
            this.emit('activity-hover', this._heldId, false);
            this._heldId = null;
        }
        this._activity = current;
        // A dropdown always shows its card when it has one, and so does a
        // notch told to open by itself (setAutoOpen).
        this._activityExpanded = !!current && !!current.content.expanded &&
            (this._placement === 'dropdown' || this._autoOpen || this.hover);

        if (!current) {
            this._popOut();
            return;
        }

        this._render();
        if (!wasShown || !this._wanted || this._poppingOut)
            this._popIn();
        // A new activity that opens under the pointer is held open like a hovered one.
        if ((this._opensItself() ? this.hover : this._activityExpanded) && !this._heldId) {
            this._heldId = current.id;
            this.emit('activity-hover', current.id, true);
        }
    }

    _popIn() {
        if (this._placement === 'notch') {
            this._popInNotch();
            return;
        }
        this._poppingOut = false;
        this.remove_transition('opacity');
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this._wanted = true;
        this._syncVisible();
        this._reposition();
        if (!this._motionAllowed()) {
            this.opacity = 255;
            this.set_scale(1, 1);
            return;
        }
        const [popX, popY] = this._popScale();
        this.opacity = 0;
        this.set_scale(popX, popY);
        // Opacity must not use EASE_OUT_BACK: its overshoot goes past 255,
        // which wraps to nearly transparent and flashes the bubble.
        this.ease({
            opacity: 255,
            duration: POP_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.ease({
            scale_x: 1,
            scale_y: 1,
            duration: POP_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _popScale() {
        return [POP_SCALE, POP_SCALE];
    }

    // Hidden for good (nothing shown, back to the empty compact state).
    _clearPop() {
        this._poppingOut = false;
        this._cancelLeaveWatch();
        this._wanted = false;
        this._syncVisible();
        this.opacity = 255;
        this.set_scale(1, 1);
        this._render();
    }

    _popOut() {
        if (this._retired || !this.visible || !this.mapped || !this._motionAllowed()) {
            this._clearPop();
            return;
        }
        if (this._placement === 'notch') {
            this._leaveNotch();
            return;
        }
        this._poppingOut = true;
        this.ease({
            opacity: 0,
            scale_x: this._popScale()[0],
            scale_y: this._popScale()[1],
            duration: POP_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._poppingOut && !this._activity)
                    this._clearPop();
            },
        });
    }

    // ---- Notch: the shape itself grows out of the closed notch and shrinks back.

    // The closed notch's size in physical px (what the island's notch is).
    _closedSize() {
        const scale = scaleFactor();
        return [NOTCH_WIDTH * scale, Math.round(BAR_HEIGHT * scale)];
    }

    // Arriving. Called after setActivity's _render() (which, with the bubble
    // hidden, applied the content at its natural size without animating).
    //  - Still on screen shrinking (_poppingOut): take over. _render() already
    //    superseded the shrink and morphs from the current size to the new
    //    one; nothing is reset, so there is no jump to closed and back.
    //  - Otherwise: show it opaque at exactly the closed notch (size, corner
    //    radius, flush with the top), then morph to the natural size and fade
    //    the content in the way MorphBox's _swapIn does.
    _popInNotch() {
        if (this._poppingOut && this._wanted) {
            this._poppingOut = false;
            this._cancelLeaveWatch();
            this._syncVisible();
            return;
        }
        this._poppingOut = false;
        this._cancelLeaveWatch();
        this.remove_transition('opacity');
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this.opacity = 255;
        this.set_scale(1, 1);
        this._wanted = true;
        if (!this._motionAllowed()) {
            this._syncVisible();
            this._reposition();
            return;
        }
        // Before it is visible, so no frame is drawn at another size or radius.
        this._stopMorph();
        this._resetContent();
        this._radius = Math.min(Math.round(BAR_HEIGHT / 2), EXPANDED_RADIUS);
        this.set_style(this._radiusStyle(this._radius));
        const [width, height] = this._closedSize();
        this.set_size(width, height);
        this._syncVisible();
        this._reposition();
        if (!this.visible || !this.mapped) {
            // Hidden for a fullscreen window: nothing to see, show it at its size.
            this._stopMorph();
            this.set_size(-1, -1);
            return;
        }
        const incoming = this._containers().filter(a => a.visible);
        for (const actor of incoming) {
            actor.opacity = 0;
            actor.set_scale(CONTENT_IN_SCALE, CONTENT_IN_SCALE);
        }
        this._morph(true);
        for (const actor of incoming) {
            actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: CONTENT_IN_MS,
                delay: CONTENT_IN_DELAY_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // Leaving: _render() with no activity fades the content out, then
    // morphs the shape to _naturalSize(), which is the closed notch. The
    // bubble hides only once that morph is over (_queueLeaveCheck).
    // Already leaving: the extension clears empty bubbles on every manager
    // change, and restarting here would postpone the watchdog forever.
    _leaveNotch() {
        if (this._poppingOut && !this._activity)
            return;
        this._poppingOut = true;
        this._cancelLeaveWatch();
        // Animations run slower by the shell's slow-down factor; so does this.
        const watchdogMs = Math.round((CONTENT_OUT_MS + MORPH_MS + NOTCH_LEAVE_MARGIN_MS) *
            St.Settings.get().slow_down_factor);
        this._leaveWatchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, watchdogMs, () => {
            this._leaveWatchdogId = 0;
            if (this._poppingOut && !this._activity)
                this._clearPop();
            return GLib.SOURCE_REMOVE;
        });
        this._render();
    }

    _cancelLeaveWatch() {
        if (this._leaveLaterId)
            global.compositor.get_laters().remove(this._leaveLaterId);
        this._leaveLaterId = 0;
        if (this._leaveWatchdogId)
            GLib.source_remove(this._leaveWatchdogId);
        this._leaveWatchdogId = 0;
    }

    // Before the next frame: hide if the shape is at rest while leaving.
    // A morph that is still playing, or the fade-out before it, re-queues
    // this when it ends (_morph below, and _morphStopped).
    _queueLeaveCheck() {
        if (this._leaveLaterId || !this._live())
            return;
        this._leaveLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._leaveLaterId = 0;
            if (!this._live() || !this._poppingOut || this._activity || this._pending)
                return GLib.SOURCE_REMOVE;
            const playing = ['width', 'height'].some(name => this.get_transition(name)?.is_playing());
            if (!playing)
                this._clearPop();
            return GLib.SOURCE_REMOVE;
        });
    }

    _morph(animate) {
        super._morph(animate);
        if (this._placement !== 'notch' || !this._poppingOut || this._activity)
            return;
        this._queueLeaveCheck();
    }

    // Interrupted (a scale change) or finished, whether the width, the
    // height or both moved: either way, check again.
    _morphStopped() {
        if (this._placement === 'notch' && this._poppingOut && !this._activity)
            this._queueLeaveCheck();
    }

    _setActivityExpanded(expanded) {
        if (!this._activity?.content.expanded)
            expanded = false;
        if (this._activityExpanded === expanded)
            return;
        this._activityExpanded = expanded;
        const id = this._activity?.id ?? this._heldId;
        if (id && (expanded ? this._heldId !== id : this._heldId)) {
            this._heldId = expanded ? id : null;
            this.emit('activity-hover', id, expanded);
        }
        this._render();
    }

    // True when the card is open without the pointer: hovering then only
    // holds the activity, it does not open and close the card.
    _opensItself() {
        return this._placement === 'dropdown' || (this._autoOpen && this._activityExpanded);
    }

    /**
     * Notch: whether the next activity opens its card by itself (a short
     * event such as a notification) instead of waiting for the pointer.
     */
    setAutoOpen(open) {
        this._autoOpen = !!open;
    }

    _onHover() {
        if (this._opensItself())
            this._setHeld(this.hover);
        else
            this._setActivityExpanded(this.hover);
    }

    // Pauses (held) or restarts the live activity's timeout.
    _setHeld(held) {
        const id = this._activity?.id ?? this._heldId;
        if (!id || held === !!this._heldId)
            return;
        this._heldId = held ? id : null;
        this.emit('activity-hover', id, held);
    }

    // Centred on the primary monitor as part of the layout (see the file comment).
    vfunc_allocate(box) {
        const monitor = this._placement === 'beside' ? null : Main.layoutManager.primaryMonitor;
        if (monitor) {
            const width = box.get_width();
            const x = Math.floor(monitor.x + (monitor.width - width) / 2);
            box = Clutter.ActorBox.new(x, box.y1, x + width, box.y2);
        }
        super.vfunc_allocate(box);
    }

    // Notch corners for the notch; the default round ones otherwise.
    _radiusStyle(r) {
        return this._placement === 'notch' ? `border-radius: 0 0 ${r}px ${r}px;` : super._radiusStyle(r);
    }

    vfunc_get_preferred_height(forWidth) {
        return this._withIslandHeight(super.vfunc_get_preferred_height(forWidth));
    }

    _naturalSize() {
        // A notch with nothing to show is the closed notch, exactly.
        if (this._placement === 'notch' && !this._activity)
            return this._closedSize();
        const [width, height] = super._naturalSize();
        return [this._withBareWidth([0, width])[1], this._withIslandHeight([0, height])[1]];
    }

    _withIslandHeight([min, nat]) {
        if (this._activityExpanded)
            return [min, nat];
        if (this._placement !== 'beside') {
            // The notch is as tall as the bar while compact; a dropdown is as tall as its content.
            const closed = this._placement === 'notch' ? Math.round(BAR_HEIGHT * scaleFactor()) : 0;
            return [Math.max(min, closed), Math.max(nat, closed)];
        }
        if (!this._island._live())
            return [min, nat];
        const height = this._island.height;
        return [Math.max(min, height), Math.max(nat, height)];
    }

    _containers() {
        return [this._compactBin, this._expandedBin];
    }

    _stateKey() {
        return this._activity ? `${this._activity.id}|${this._activityExpanded}` : 'none';
    }

    _applyContent() {
        const activity = this._activity;
        const expanded = !!activity && this._activityExpanded && !!activity.content.expanded;

        this._compactBin.child?.destroy();
        this._expandedBin.child?.destroy();
        if (activity) {
            const factory = expanded ? activity.content.expanded : activity.content.compact;
            try {
                (expanded ? this._expandedBin : this._compactBin).set_child(factory());
            } catch (e) {
                this._reportActivityError(activity.id, e);
            }
        }

        this._compactBin.visible = !expanded;
        this._expandedBin.visible = expanded;
        this._setStyleClass('dynland-activity-expanded', expanded);
        this._syncBare();
    }

    // Beside the island's small empty pill (auto-hide off, closed), a compact
    // bubble takes the pill's size so the pair reads as one symmetric unit.
    // Set as geometry rather than a style class: a style change on the bubble
    // while the island morphs left it without an allocation for a frame.
    // Off the stage (or with the island off it) nothing is measured or
    // resized; it syncs on arriving (_onStage) and on the island's next change.
    _syncBare() {
        if (this._placement === 'dropdown' || !this._live())
            return;
        if (this._placement === 'notch') {
            // The closed notch: its own size, whatever the island underneath does.
            this._setBare(!this._activityExpanded, BAR_HEIGHT);
            return;
        }
        if (!this._island._live())
            return;
        const notch = this._island.has_style_class_name('dynland-notch');
        const bare = (notch || this._island.has_style_class_name('dynland-bare')) && !this._activityExpanded;
        this._setBare(bare, notch ? BAR_HEIGHT : BARE_HEIGHT);
    }

    // The row height is in physical px, so a changed scale redoes it even
    // when the state is the same (_onScale).
    _setBare(bare, height) {
        const scale = scaleFactor();
        if (bare === this._bare && (!bare || height === this._bareHeight) && scale === this._bareScale)
            return;
        this._bare = bare;
        this._bareHeight = height;
        this._bareScale = scale;
        // The compact row otherwise keeps GNOME's panel height; the width is
        // clamped in the size requests below, which the morph reads.
        this._compactBin.height = bare ? (height - 2 * BARE_PADDING) * scale : -1;
    }

    // From MorphBox's deferred scale step: the bare row height, and the
    // clamped widths and heights (read afresh from the size requests, which
    // the relayout after this asks again), follow the new scale. The
    // position (the gap, the top edge) is _reposition's, run next.
    _onScale() {
        this._syncBare();
        this._queueFollow();
    }

    // Whatever the island did while this was off the stage, catch up.
    _onStage() {
        this._syncBare();
        this._queueFollow();
    }

    vfunc_get_preferred_width(forHeight) {
        return this._withBareWidth(super.vfunc_get_preferred_width(forHeight));
    }

    _withBareWidth([min, nat]) {
        if (!this._bare)
            return [min, nat];
        const width = (this._placement === 'notch' ? NOTCH_WIDTH : BARE_WIDTH) * scaleFactor();
        return [Math.max(min, width), Math.max(nat, width)];
    }

    // The error handler may release the activity and re-enter setActivity, so
    // it must never run from inside a render or swap.
    _reportActivityError(id, error) {
        const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._errorSources.delete(sourceId);
            this._onActivityError(id, error);
            return GLib.SOURCE_REMOVE;
        });
        this._errorSources.add(sourceId);
    }

    // Its own width changes mid-layout as well (the bare size, a morph).
    _onWidthChanged() {
        this._queueFollow();
    }

    // Moves beside the island, and (compact) takes its height, before the next frame.
    _queueFollow() {
        if (this._followId || !this._live())
            return;
        this._followId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._followId = 0;
            if (!this._live())
                return GLib.SOURCE_REMOVE;
            this._reposition();
            if (!this._activityExpanded)
                this.queue_relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reposition() {
        if (this._placement !== 'beside') {
            // Only the top edge is set (x is centred in vfunc_allocate), and
            // only when it changes: it changes with the monitor or the scale.
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor || !this._live())
                return;
            const top = this._placement === 'notch' ? TOP_MARGIN : BAR_HEIGHT + DROPDOWN_GAP;
            const y = monitor.y + top * scaleFactor();
            if (this._fixedY !== y) {
                this._fixedY = y;
                this.set_position(monitor.x, y);
            }
            return;
        }
        const island = this._island;
        if (!this._live() || !island._live())
            return;
        const previous = this._previous;
        const anchor = previous?.visible && previous._live() ? previous : island;
        // Where the anchor is heading, not where it is mid-slide; the island's
        // `x` is 0 while it awaits allocation, so ask where it is drawn.
        const anchorX = anchor._slideTo ?? (anchor === island ? island.drawnX : anchor.x);
        const x = Math.floor(anchorX + anchor.width + GAP * scaleFactor());
        const slide = this._anchor && anchor !== this._anchor && this.visible && this._motionAllowed();
        this._anchor = anchor;

        this.y = island.y;
        if (slide || (this._slideTo !== null && this._slideTo !== x)) {
            // The bubble before it came or went: slide over instead of jumping.
            this._slideTo = x;
            this.ease({
                x,
                duration: SLIDE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._slideTo = null;
                },
            });
        } else if (this._slideTo === null) {
            this.x = x;
        }
    }
});
